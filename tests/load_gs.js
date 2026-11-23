// Loads Apps Script (.gs) files into one Node vm context so their globals can be tested.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadGs(files, extraGlobals = {}) {
  const context = vm.createContext({ console, ...extraGlobals });
  for (const f of files) {
    const file = path.join(__dirname, '..', 'apps-script', f);
    vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  }
  return context;
}

module.exports = { loadGs };
