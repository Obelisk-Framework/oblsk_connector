const http = require('http');
const mysql = require('mysql2/promise');

const PORT = process.env.MYSQL_SERVER_PORT || 3000;

let pools = {};

const getPool = async (config) => {
    const key = `${config.host}:${config.port}:${config.user}:${config.database}`;
    
    if (!pools[key]) {
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
    
    return pools[key];
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
                const host = payload.host || 'localhost';
                const port = payload.port || 3306;
                const user = payload.user || 'root';
                const password = payload.password || '';
                const database = payload.database || 'fivem';

                if (!query) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'No query provided' }));
                    return;
                }

                console.log('[Query]', query.substring(0, 100) + (query.length > 100 ? '...' : ''));

                const pool = await getPool({ host, port, user, password, database });
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
