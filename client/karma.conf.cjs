const path = require('node:path');

module.exports = config => config.set({
  basePath: '',
  frameworks: ['jasmine', '@angular-devkit/build-angular'],
  plugins: ['karma-jasmine', 'karma-chrome-launcher', 'karma-jasmine-html-reporter',
    'karma-coverage', '@angular-devkit/build-angular/plugins/karma'].map(name => require(name)),
  reporters: ['progress', 'kjhtml'],
  jasmineHtmlReporter: { suppressAll: true },
  browsers: ['Chrome'],
  customLaunchers: {
    ChromeHeadlessNoSandbox: { base: 'ChromeHeadless', flags: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] },
  },
  coverageReporter: {
    dir: path.join(__dirname, 'coverage', 'client'), subdir: '.',
    reporters: [{ type: 'html' }, { type: 'text-summary' }],
  },
  // A rendered 100-ply fakeAsync match can hold the browser thread beyond Karma's 5-second heartbeat.
  pingTimeout: 60000,
  browserNoActivityTimeout: 90000,
  restartOnFileChange: true,
});
