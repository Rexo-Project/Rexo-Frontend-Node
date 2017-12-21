module.exports = (function() {
  var async = require('async'),
      jucks = require('nunjucks'),
      njm = require('nunjucks-markdown'),
      marked = require('marked'),
      highlightjs = require('highlight.js'),
      minify = require('html-minifier').minify,
      minifyOpts = {
        collapseWhitespace: true
      },
      request = require('request'),
      fs = require('fs'),
      aws = require('aws-sdk'),
      compiledCache = {},
      controller = {};
  
  var nje = jucks.configure({
    autoescape:false, //Prevent nunjucks filters from autoescaping HTML
    noCache: true //Disable any caching the nunjucks engine does
  });

  //Provide a couple globals for use with any template
  nje.addGlobal('cdn', process.env.CDN_URL);
  nje.addGlobal('rexo-project', process.env.REXO_PROJECT);

  //Configure the markdown tag
  njm.register(nje, marked);

  //Configure syntax highlighting for code blocks
  marked.setOptions({
    highlight: function (code, langauge) {

      //Splits the code into lines to support line numbering
      return code.split('\n').map(function(codeLine) {
        return '<span class="hljs-line">' + 
          highlightjs.highlight(langauge, codeLine).value +
          '</span>';
      }).join('\n');
    }
  });

  //When using the staging or prod (or any non-dev) env,
  //setup the connection to S3, where the live templates 
  //are stored.
  if(process.env.NODE_ENV !== 'development') {
    aws.config.update({
      region: process.env.AWS_TEMPLATE_REGION,
      credentials: {
        accessKeyId: process.env.AWS_TEMPLATE_KEY,
        secretAccessKey: process.env.AWS_TEMPLATE_SECRET 
      }});
    
    var templatesS3 = new aws.S3({
      params: {
        Bucket: process.env.AWS_TEMPLATE_BUCKET
      }
    });
  }

  //Convenience function that will return the callback for retrieving
  //template files. Works for both local files and via S3.
  var getTemplateCallback = function(name, cache, cb) {
    return function(err, tpl) {
      if(err) {
        return cb(err, null);
      }

      var tplString = (tpl.Body ? tpl.Body.toString() : tpl);

      if(cache) {
        compiledCache[name] = jucks.compile(tplString, nje);
      }

      cb(err, compiledCache[name] || tplString);
    };
  };
  
  /*
   * Loads a template file, but does not render it. It will
   * cache the a compliled version if requested.
   * The location of the template will vary by environment.
   * @param {string} key - The location identify, IE the
   * path.
   * @param {function} cb - The callback to run when the
   * file has been loaded.
   */
  var getTemplate = function(name, path, cache, cb) {
    if(name && compiledCache[name]) {
      return cb(null, compiledCache[name]);
    }

    var file = (process.env.TEMPLATE_PATH || '') + '/' + path;

    if(process.env.NODE_ENV === 'development') {
      fs.readFile(file, 'utf8', getTemplateCallback(name, cache, cb));
     } else {
      templatesS3.getObject({Key:file},getTemplateCallback(name, cache, cb));
    }
  };

  /*
   * Calls the data API. A fairly general implementation.
   * The route structure is expected to be /[type]/[key].
   * @param {string} type - The type of resource to get, IE
   * the first part of the route to call.
   * @param {string|number} key - The indentifier for a single
   * resource to retrieve. When not given, it is assumed you
   * want to get all resources of a specific type.
   * @param {function} cb - The callback to run when the
   * API returns.
   */
  var getData = function(type, key, cb) {
    var reqOptions = {
      url: process.env.DATA_API_URL + type + (key ? '/' + key : "")
    };

    //Add the API Key to the header, if provided
    if(process.env.DATA_API_KEY) {
      reqOptions.headers = { 'x-api-key': process.env.DATA_API_KEY };
    }

    request(reqOptions, function(err, res, body) {
        if(res.statusCode != 200 && res.statusCode != 404) {
            err = new Error('Request to ' + reqOptions.url +
              ' returned ' + res.statusCode);
        }

        cb(err, JSON.parse(body || "{}"));
    });
  };

  //Convenience helper that is used with the template rendering.
  //[this] is bound to the render callback.
  var renderCallback = function(err, html) {
    this(err, minify(html || "", minifyOpts));
  };

  /*
   * Takes the page definition, gets any template files and 
   * data, then builds the template context and renders it.
   * Returns the rendered HTML via a callback.
   * @param {object} page - The page definition retruned
   * from the database.
   * @param {array} routeParams - The parameters given
   * via the path requested.
   * @param {function(err, html)} callback - The callback
   * to run when page rendering is complete, or if error.
   */
  var buildPage = function(page, routeParams, callback) {
    var asyncCalls = {},
        pageTemplate, tpl,
        pageCtx = {
          title: page.Title,
          description: page.Description,
          content: page.Content,
          templates: {},
          data: {}
        };
    
    //Setup the async calls and add any template data
    //to the page context
    for(var t = 0; t < page.Templates.length; t++) {
      tpl = page.Templates[t];

      //Add an async call to get get each template
      asyncCalls['template'+ tpl.Name] = async.apply(getTemplate,
        tpl.Name,
        tpl.Path,
        //Don't cache the page's template
        //but cache any templates it requires
        (tpl.TemplateId === page.PageTemplate ? false : true)
      );

      //Keep track of the name for the page's template
      if(tpl.TemplateId === page.PageTemplate) {
        pageTemplate = tpl.Name;
      }

      //Add any data found to the page context
      if(tpl.Data) {
        for(var d in tpl.Data) {
          pageCtx.data[d] = tpl.Data[d];
        }
      }
    }

    if(routeParams && routeParams.length === 1) {
      asyncCalls['data' + page.Slug] = async.apply(getData,
        page.Slug.toLowerCase(),
        routeParams[0]);
    }

    async.auto(asyncCalls, function(err, responses) {
      if(err) {
        callback(err, null);
      } else {
        for(var r in responses) {
          if(r.indexOf('template') === 0) {
            tpl = r.replace('template', '');

            //The templates are added to the page context
            //except for the page's template which is kept 
            //track of for rendering
            if(tpl !== pageTemplate) {
              pageCtx.templates[tpl] = responses[r];
            } else {
              pageTemplate = responses[r];
            }
          }

          if(r.indexOf('data') === 0) {
            pageCtx.data[r.replace('data', '')] = responses[r];
          }
        }
        
        //if the page template is not a string, it is a compiled template
        if(typeof pageTemplate !== 'string') {
          pageTemplate.render(pageCtx, renderCallback.bind(callback));
        } else {
          jucks.renderString(pageTemplate, pageCtx, renderCallback.bind(callback));
        }
      }
    });
  };

  /*
   * Compiles a page by retrieving both the template and its
   * data, then returns the rendered HTML.
   * @parma {string} route - The route that was requested.
   * @param {function} callback - The callback to run when the
   * page HTML is ready.
   */
  controller.render = function(route, callback) {

    var params = route.substring(1).split('/');

    //if no route was given (site index), use the home page
    if(params[0].length <= 0) {
      params = ['home'];
    }

    getData('page', params[0].toLowerCase(), function(err, pageData) {
      console.log(pageData);
      if(pageData && pageData.Slug) {
        buildPage(pageData, params.slice(1), callback);
      } else {
        callback(err, null);
      }
    });
  };
  
  return controller;
})();