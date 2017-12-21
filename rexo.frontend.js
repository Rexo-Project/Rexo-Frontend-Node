var template = require(__dirname + '/controller.template.js');

var serverError = function(error) {
  return {
    statusCode: 500,
    body: "<p>" + error.message +"</p>"
  };
};

module.exports = function(event, context, callback) {
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

