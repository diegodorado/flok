const fs = require('fs')
const path = require('path')
const https = require('https')

// if production, force https
module.exports = (app) => {
  var privateKey = fs.readFileSync(path.join(__dirname, '../certs/key.pem'), 'utf8')
  var certificate = fs.readFileSync(path.join(__dirname, '../certs/certificate.pem'), 'utf8')
  var credentials = {key: privateKey, cert: certificate}
  return https.createServer(credentials, app)
}
