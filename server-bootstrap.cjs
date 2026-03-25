const fs = require('fs');
const path = require('path');
const Module = require('module');

const serverPath = path.join(__dirname, 'server.js');

if (!fs.existsSync(serverPath)) {
  throw new Error(`Missing server.js at ${serverPath}`);
}

const serverCode = fs.readFileSync(serverPath, 'utf8');
const serverModule = new Module(serverPath, module);
serverModule.filename = serverPath;
serverModule.paths = Module._nodeModulePaths(__dirname);
serverModule._compile(serverCode, serverPath);
