'use strict';
const { migrate, dbPath } = require('./index');
migrate();
console.log(`Schema applied to ${dbPath}`);
