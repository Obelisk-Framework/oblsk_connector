local MySQL = {}
MySQL.config = {
    host = '127.0.0.1',
    port = 3306,
    user = 'root',
    password = '',
    database = 'fivem'
}

local function escape(str)
    if str == nil then return 'NULL' end
    if type(str) == 'boolean' then return str and '1' or '0' end
    if type(str) == 'number' then return tostring(str) end
    str = tostring(str)
    str = str:gsub('\\', '\\\\')
    str = str:gsub("'", "\\'")
    str = str:gsub('\0', '\\0')
    str = str:gsub('\n', '\\n')
    str = str:gsub('\r', '\\r')
    return "'" .. str .. "'"
end

local function parseQuery(query, params)
    if not params or #params == 0 then
        return query
    end
    
    local paramIndex = 1
    local result = query:gsub('?', function()
        if paramIndex <= #params then
            local val = params[paramIndex]
            paramIndex = paramIndex + 1
            return escape(val)
        end
        return '?'
    end)
    
    return result
end

local function parseConnectionString(connectionString)
    if not connectionString or connectionString == '' then
        return nil
    end

    local config = {}
    local userPass, hostPath = connectionString:match('mysql://([^@]+)@(.+)')
    
    if userPass then
        config.user, config.password = userPass:match('([^:]+):(.+)')
    end
    
    if hostPath then
        local hostPort, database = hostPath:match('([^/]+)/(.+)')
        if hostPort then
            local host, port = hostPort:match('([^:]+):?(%d*)')
            config.host = host
            config.port = tonumber(port) or 3306
            config.database = database
        end
    end
    
    return config
end

function MySQL.executeSync(query, params)
    if not query or query == '' then
        return {}
    end

    local isPostgres = MySQL.config.driver == 'postgres'
    -- MySQL path: escape + interpolate client-side (unchanged behavior).
    -- Postgres path: send the raw '?'-placeholder query + unescaped params;
    -- index.js translates placeholders and lets `pg` bind them for real.
    local outgoingQuery = isPostgres and query or parseQuery(query, params)
    local result = {}
    local requestDone = false

    local payload = json.encode({
        query = outgoingQuery,
        params = isPostgres and (params or {}) or nil,
        driver = MySQL.config.driver,
        host = MySQL.config.host,
        port = MySQL.config.port,
        user = MySQL.config.user,
        password = MySQL.config.password,
        database = MySQL.config.database
    })

    print('[oblsk_connector] Executing query: ' .. outgoingQuery:sub(1, 100))
    
    PerformHttpRequest('http://127.0.0.1:3000/query', function(statusCode, response, headers)
        if statusCode == 200 then
            print('[oblsk_connector] Response: ' .. (response or 'nil'))
            local success, data = pcall(json.decode, response)
            if success and data then
                result = data
            end
        else
            if statusCode ~= 0 then
                print('[oblsk_connector] HTTP Error ' .. statusCode .. ': ' .. (response or 'No response'))
            end
        end
        requestDone = true
    end, 'POST', payload, {
        ['Content-Type'] = 'application/json'
    })
    
    local timeout = 0
    while not requestDone and timeout < 400 do
        Citizen.Wait(10)
        timeout = timeout + 1
    end
    
    if not requestDone then
        print('[oblsk_connector] Warning: HTTP request timed out after 4 seconds')
    end
    
    return result
end

local Connector = {}
Connector.ready = false
Connector.config = MySQL.config

local function executeSync(query, params)
    if not query or query == '' then
        return {}
    end

    local success, result = pcall(function()
        return MySQL.executeSync(query, params)
    end)

    if success and result then
        return result
    end

    if not success then
        print('[oblsk_connector] Query Error: ' .. tostring(result))
    end

    return {}
end

local function execute(query, params, callback)
    if type(params) == 'function' then
        callback = params
        params = nil
    end

    Citizen.CreateThread(function()
        local result = executeSync(query, params)
        if callback then
            callback(result)
        end
    end)
end

--- Run a batch of statements atomically on a single connection.
--- Each entry may be a raw SQL string or { query = string, values = table }.
--- Statements are interpolated with the same escaping as executeSync, then run
--- inside a real BEGIN/COMMIT (ROLLBACK on error) server-side.
--- @param queries table
--- @return boolean success
local function transactionSync(queries)
    if type(queries) ~= 'table' or #queries == 0 then
        return true
    end

    local isPostgres = MySQL.config.driver == 'postgres'
    local statements = {}
    for _, item in ipairs(queries) do
        if isPostgres then
            if type(item) == 'table' then
                statements[#statements + 1] = { query = item.query, values = item.values or {} }
            else
                statements[#statements + 1] = { query = tostring(item), values = {} }
            end
        elseif type(item) == 'table' then
            statements[#statements + 1] = parseQuery(item.query, item.values)
        else
            statements[#statements + 1] = tostring(item)
        end
    end

    local result = {}
    local requestDone = false

    local payload = json.encode({
        queries = statements,
        driver = MySQL.config.driver,
        host = MySQL.config.host,
        port = MySQL.config.port,
        user = MySQL.config.user,
        password = MySQL.config.password,
        database = MySQL.config.database
    })

    print('[oblsk_connector] Executing transaction: ' .. #statements .. ' statement(s)')

    PerformHttpRequest('http://127.0.0.1:3000/transaction', function(statusCode, response, headers)
        if statusCode == 200 then
            local success, data = pcall(json.decode, response)
            if success and data then
                result = data
            end
        else
            if statusCode ~= 0 then
                print('[oblsk_connector] Transaction HTTP Error ' .. statusCode .. ': ' .. (response or 'No response'))
            end
        end
        requestDone = true
    end, 'POST', payload, {
        ['Content-Type'] = 'application/json'
    })

    local timeout = 0
    while not requestDone and timeout < 400 do
        Citizen.Wait(10)
        timeout = timeout + 1
    end

    if not requestDone then
        print('[oblsk_connector] Warning: transaction HTTP request timed out after 4 seconds')
        return false
    end

    return result.success == true
end

local function init()
    MySQL.config.driver = GetConvar('db_driver', 'mysql')
    Connector.config.driver = MySQL.config.driver

    local connectionString = GetConvar('mysql_connection_string', '')

    if connectionString ~= '' then
        local parsed = parseConnectionString(connectionString)
        if parsed then
            for k, v in pairs(parsed) do
                if v and v ~= '' then
                    MySQL.config[k] = v
                    Connector.config[k] = v
                end
            end
        end
    end

    Connector.ready = true

    print('[oblsk_connector] ✓ Using builtin')
    print('[oblsk_connector] Config: ' .. MySQL.config.user .. '@' .. MySQL.config.host .. ':' .. MySQL.config.port .. '/' .. MySQL.config.database)
end

exports('executeSync', executeSync)
exports('execute', execute)
exports('transactionSync', transactionSync)

init()
