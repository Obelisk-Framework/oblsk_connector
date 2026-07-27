fx_version 'cerulean'
game 'gta5'

author 'Obelisk Framework'
description 'MySQL Connector Wrapper for Obelisk Framework'
version '1.0.0'

lua54 'yes'

exports {
    'executeSync',
    'execute',
    'transactionSync'
}

server_scripts {
    'server.lua'
}
