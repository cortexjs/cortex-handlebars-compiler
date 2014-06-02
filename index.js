'use strict';

module.exports = compiler;

var handlebars = require('handlebars');
var hashmaps = require('neuron-hashmaps');
var node_path = require('path');
var semver = require('semver');
var pkg = require('neuron-pkg');
var node_url = require('url');

function compiler (options) {
  return new Compiler(options || {});
}

// @param {Object} options basic information of the template, not userdata. 
// Including:
// - information of the template
// - global configurations of the environment
// Properties:
// - pkg `Object` object of cortex.json
// - shrinkWrap `Object` object of cortex-shrinkwrap.json
// - cwd `path` the root directories of current project.
// - path `path` path of the current template file
// X - built_root `path` the root directories of packages to be built into
// - ext `String='.js'` the extension of module files, default to `'.js'`
function Compiler (options) {
  this.facade_counter = 0;

  this._check_option(options, 'pkg');
  this._check_option(options, 'shrinkWrap');
  this._check_option(options, 'cwd');
  this._check_option(options, 'path');
  this._check_option(options, 'built_root');
  this.ext = options.ext || '.js';
  this.href_root = options.href_root;

  this.cwd = node_path.resolve(this.cwd);
  this.path = node_path.resolve(this.cwd, this.path);

  this.neuron_hashmaps = hashmaps(options.shrinkWrap);

  this.register('facade', this._facade_handler, this);
  this.register('href', this._href_handler, this);
}


Compiler.prototype._check_option = function(options, key, message) {
  if (!message) {
    message = '`options.' + key + '` must be specified';
  }
  if (!options[key]) {
    throw new Error(message);
  }
  this[key] = options[key];
};


// Register a custom helper
// @param {String} helper
// @param {function(title, options)} handler
// - title
// - options
Compiler.prototype.register = function(helper, handler, context) {
  if (context) {
    handler = handler.bind(context);
  }
  handlebars.registerHelper(helper, handler);
  return this;
};


// Comple the template
Compiler.prototype.compile = function(template) {
  return handlebars.compile(template);
};


Compiler.prototype._config_path = function() {
  // built_root/
  //          |-- <name>
  //                  |-- <version>
  //                              |-- dir/to/template
  //                                                |-- <path.basename>
  // ------------------------------------------------------------------
  //                              |         |
  var dir = node_path.dirname(this.path);
  var relative_to_cwd = node_path.relative(dir, this.cwd);
  return node_path.join('..', '..', relative_to_cwd);
};


Compiler.prototype._facade_handler = function(title, options) {
  var output = '';
  if (this.facade_counter ++ === 0) {
    output += this._neuron_framework();
  }

  output += [
    '<script>',
      'facade({',
        'mod:"' + this._facade_mod(title) + '"',
      '});',
    '</script>'
  ].join('');

  return output;
};


// a.html
// {{href ./b.html}}
// {{href b/b.html}}
Compiler.prototype._href_handler = function(title, options) {
  var link = title;
  if (!link) {
    throw new Error('invalid argument for helper `href`.');
  }

  // './b.html'
  // normal -> './b.html'
  // hybrid -> 'protocol://efte/<name>/<relative>/b.html'
  if (this.href_root) {
    link = this._hybrid_href(title);
  }
};


Compiler.prototype._is_relative = function(path) {
  return path === '.'
    || path.indexOf('./') === 0
    || this._is_parent_path(path);
};


Compiler.prototype._is_parent_path = function(path) {
  return path === '..'
    || path.indexOf('../') === 0;
};


// TODO: -> config
Compiler.prototype._hybrid_href = function(title) {
  var name = this.pkg.name;
  var template_relative = node_path.relative(this.cwd, this.path);
  var dir_relative = node_path.dirname(template_relative);
  var link_relative = node_path.join(dir_relative, title);
  // dir: 'template/'
  // title: '../../b.html'
  // -> allow to use a resource outside current repo? NO!
  // Then:
  // title: '../template/../../b.html' ? NO!
  if (this._is_parent_path(link_relative)) {
    throw new Error('You should never link to a resource outside current project.');
  }

  return node_url.resolve(this.href_root, link_relative);
};


// Suppose current package:
// name: foo
// version: 0.2.0
// Then,
// 1.
// facade(foo) -> facade(foo@0.2.0)
// 2.
// facade() -> facade(foo@0.2.0)
// 3.
// facade(foo/abc) -> facade(foo@0.2.0/abc)
// 4.
// facade(foo@1.2.3) -> check if 1.2.3 exists in current shrinkwrap, otherwise -> throw
Compiler.prototype._facade_mod = function(title) {
  var name = this.pkg.name;
  var version = this.pkg.version;

  // facade() -> current package
  if (!title || Object(title) === title) {
    return pkg.format({
      name: name,
      version: version
    });
  }

  var obj = pkg(title);
  // if the facade uses the current package, force the version
  if (obj.name === name) {
    obj.version = version;
  }

  if (obj.version) {
    return pkg.format(obj);
  }

  // 'a' -> 'a@latest'
  obj.range = obj.range || 'latest';

  var is_range_valid = semver.validRange(obj.range) || obj.range === 'latest';

  var facade_pkg = pkg.format({
    name: obj.name,
    range: obj.range
  });

  if (!is_range_valid) {
    throw new Error(
      'Facade: invalid version "' + facade_pkg + '", make sure you have install it.\n' +
      'Or you might as well specify the explicit version of "' + facade_name + '".'
    );
  }

  // parse ranges
  obj.version = this._parse_range(obj.name, obj.range);
  if (!obj.version) {
    throw new Error('Facade: invalid range "' + facade_pkg + '", make sure your have `cortex install --save` it.');
  }

  return pkg.format(obj);
};


Compiler.prototype._parse_range = function(name, range) {
  var ranges = this.neuron_hashmaps.ranges;
  return ranges[name] && ranges[name][range];
};


Compiler.prototype._neuron_framework = function() {
  return this._output_engines() + this._neuron_config();
};


Compiler.prototype._output_engines = function() {
  var self = this;
  return this.neuron_hashmaps
  .engines(this.pkg.name, this.pkg.version)
  .map(function (engine) {
    var src = self._normalize(engine.name, engine.version);
    return '<script src="' + src + '"></script>';
  })
  .join('');
};


Compiler.prototype._neuron_config = function() {
  return '' + [
    '<script>',
    'neuron.config({',
      'ranges:'  + JSON.stringify(this.neuron_hashmaps.ranges) + ',',
      'depTree:' + JSON.stringify(this.neuron_hashmaps.depTree) + ',',
      'path:"' + this._config_path() + '"',
    '});',
    '</script>'
  ].join('');
};


Compiler.prototype._normalize = function(name, version) {
  return node_path.join(this.root, name, version, name + this.ext);
};
