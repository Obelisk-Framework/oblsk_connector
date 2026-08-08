const http = require('http');
const mysql = require('mysql2/promise');
const { Pool: PgPool } = require('pg');

const PORT = process.env.MYSQL_SERVER_PORT || 3000;

let pools = {};

const getPool = async (driver, config) => {
    const key = `${driver}:${config.host}:${config.port}:${config.user}:${config.database}`;

    if (!pools[key]) {
        if (driver === 'postgres') {
            pools[key] = new PgPool({
                host: config.host,
                user: config.user,
                password: config.password,
                database: config.database,
                port: config.port,
                max: 10
            });
            // Without this listener, an idle client dying (e.g. Postgres
            // restart, idle-in-transaction timeout) becomes an unhandled
            // 'error' event and crashes the whole Node process, taking the
            // MySQL side of this sidecar down with it.
            pools[key].on('error', (err) => console.error('[pg pool] idle client error:', err.message));
        } else {
            pools[key] = mysql.createPool({
                host: config.host,
                user: config.user,
                password: config.password,
                database: config.database,
                port: config.port,
                waitForConnections: true,
                connectionLimit: 10,
                queueLimit: 0
            });
        }
    }

    return pools[key];
};

// Translate '?' positional placeholders (Lua/QueryBuilder's format) into
// Postgres' '$1, $2, ...' — done here rather than in QueryBuilder so the
// ORM stays dialect-agnostic on placeholder syntax.
const toPositionalParams = (query) => {
    let i = 0;
    return query.replace(/\?/g, () => `$${++i}`);
};

const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'POST' && req.url === '/query') {
        let body = '';
        
        req.on('data', chunk => {
            body += chunk.toString();
        });

        req.on('end', async () => {
            try {
                const payload = JSON.parse(body);
                const query = payload.query;
                const driver = payload.driver || 'mysql';
                const host = payload.host || 'localhost';
                const port = payload.port || (driver === 'postgres' ? 5432 : 3306);
                const user = payload.user || 'root';
                const password = payload.password || '';
                const database = payload.database || 'fivem';

                if (!query) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'No query provided' }));
                    return;
                }

                console.log('[Query]', query.substring(0, 100) + (query.length > 100 ? '...' : ''));

                const pool = await getPool(driver, { host, port, user, password, database });

                if (driver === 'postgres') {
                    const text = toPositionalParams(query);
                    // FiveM's json.encode can't distinguish an empty Lua
                    // table from an empty JSON object, so an empty params
                    // table can arrive on the wire as `{}` — guard with
                    // Array.isArray rather than truthiness, since `pg`
                    // throws on a non-array values argument.
                    const values = Array.isArray(payload.params) ? payload.params : [];
                    const result = await pool.query(text, values);
                    console.log('[Result] Row count:', result.rowCount, 'Rows returned:', result.rows.length);

                    if (/^\s*(INSERT|UPDATE|DELETE)/i.test(query)) {
                        // With RETURNING <pk> (see QueryBuilder:insert), the first
                        // column of the first returned row is the new row's id.
                        const rawInsertId = result.rows.length > 0 ? Object.values(result.rows[0])[0] : 0;
                        // `pg` returns int8/bigint columns as strings to avoid
                        // precision loss beyond Number.MAX_SAFE_INTEGER. Coerce
                        // to a number when that's safe (the common case for
                        // serial/int primary keys); fall back to the raw value
                        // (string or otherwise) for genuinely huge bigints.
                        const numericInsertId = Number(rawInsertId);
                        const insertId = Number.isSafeInteger(numericInsertId) ? numericInsertId : rawInsertId;
                        res.writeHead(200);
                        res.end(JSON.stringify({
                            insertId: insertId || 0,
                            affectedRows: result.rowCount || 0
                        }));
                    } else {
                        res.writeHead(200);
                        res.end(JSON.stringify(result.rows));
                    }
                    return;
                }

                const connection = await pool.getConnection();

                try {
                    const [rows] = await connection.query(query);
                    console.log('[Result] Affected rows:', rows.affectedRows || 0, 'Rows returned:', Array.isArray(rows) ? rows.length : 0);

                    // For INSERT/UPDATE/DELETE queries, return metadata
                    if (rows.insertId !== undefined || rows.affectedRows !== undefined) {
                        res.writeHead(200);
                        res.end(JSON.stringify({
                            insertId: rows.insertId || 0,
                            affectedRows: rows.affectedRows || 0
                        }));
                    } else {
                        // For SELECT queries, return rows
                        res.writeHead(200);
                        res.end(JSON.stringify(rows));
                    }
                } finally {
                    connection.release();
                }
            } catch (error) {
                console.error('Query error:', error.message);
                res.writeHead(500);
                res.end(JSON.stringify({ error: error.message }));
            }
        });
    } else if (req.method === 'POST' && req.url === '/transaction') {
        let body = '';

        req.on('data', chunk => {
            body += chunk.toString();
        });

        req.on('end', async () => {
            try {
                const payload = JSON.parse(body);
                const queries = payload.queries;
                const driver = payload.driver || 'mysql';
                const host = payload.host || 'localhost';
                const port = payload.port || (driver === 'postgres' ? 5432 : 3306);
                const user = payload.user || 'root';
                const password = payload.password || '';
                const database = payload.database || 'fivem';

                if (!Array.isArray(queries) || queries.length === 0) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ success: false, error: 'No queries provided' }));
                    return;
                }

                console.log('[Transaction]', queries.length, 'statement(s)');

                const pool = await getPool(driver, { host, port, user, password, database });

                if (driver === 'postgres') {
                    const client = await pool.connect();
                    try {
                        await client.query('BEGIN');
                        for (const item of queries) {
                            const text = toPositionalParams(item.query);
                            const vals = Array.isArray(item.values) ? item.values : [];
                            await client.query(text, vals);
                        }
                        await client.query('COMMIT');
                        res.writeHead(200);
                        res.end(JSON.stringify({ success: true }));
                    } catch (error) {
                        try {
                            await client.query('ROLLBACK');
                        } catch (rollbackError) {
                            console.error('Rollback error:', rollbackError.message);
                        }
                        console.error('Transaction error:', error.message);
                        res.writeHead(500);
                        res.end(JSON.stringify({ success: false, error: error.message }));
                    } finally {
                        client.release();
                    }
                    return;
                }

                const connection = await pool.getConnection();

                // All statements run on this single connection inside one
                // transaction, so START TRANSACTION / COMMIT actually apply.
                try {
                    await connection.beginTransaction();
                    for (const item of queries) {
                        const sql = typeof item === 'string' ? item : item.query;
                        await connection.query(sql);
                    }
                    await connection.commit();
                    res.writeHead(200);
                    res.end(JSON.stringify({ success: true }));
                } catch (error) {
                    try {
                        await connection.rollback();
                    } catch (rollbackError) {
                        console.error('Rollback error:', rollbackError.message);
                    }
                    console.error('Transaction error:', error.message);
                    res.writeHead(500);
                    res.end(JSON.stringify({ success: false, error: error.message }));
                } finally {
                    connection.release();
                }
            } catch (error) {
                console.error('Transaction error:', error.message);
                res.writeHead(500);
                res.end(JSON.stringify({ success: false, error: error.message }));
            }
        });
    } else if (req.url === '/health') {
        res.writeHead(200);
        res.end(JSON.stringify({ status: 'ok' }));
    } else {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Not found' }));
    }
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`[oblsk_connector] MySQL server running on 0.0.0.0:${PORT}`);
});

process.on('SIGTERM', async () => {
    for (const key in pools) {
        await pools[key].end();
    }
    process.exit(0);
});
