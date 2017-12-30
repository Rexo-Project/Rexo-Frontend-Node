var winston = require('winston'),
    log = winston.log,
    template = require(__dirname + '/controller.template.js');

winston.level = process.env.LOG_LEVEL || 'info';

//Helper used to get a response object for a given error
var serverError = function(error) {
  log('error', 'Error Rendering Template! :( \n', error);

  return {
    statusCode: 500,
    body: "<p>" + error.message +"</p>"
  };
};

module.exports = function(event, context, callback) {
  log('debug', 'Request for %s recieved.', event.path);

  var res = {
    statusCode: 200,
    headers: {
      "Content-Type": "text/html"
    }
  };

  template.render(event.path, function(error, html) {
    res.body = html;

    if(error) {
      res = serverError(error);
    } else if(!html) {
      res.statusCode = 404;
      res.body = '<p>Uh, this ain\'t a page.</p>';
    }

    callback(null, res);
  });
};

