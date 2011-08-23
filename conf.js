//
//        Copyright 2010-2011 Johan Dahlberg. All rights reserved.
//
//  Redistribution and use in source and binary forms, with or without
//  modification, are permitted provided that the following conditions
//  are met:
//
//    1. Redistributions of source code must retain the above copyright notice,
//       this list of conditions and the following disclaimer.
//
//    2. Redistributions in binary form must reproduce the above copyright
//       notice, this list of conditions and the following disclaimer in the
//       documentation and/or other materials provided with the distribution.
//
//  THIS SOFTWARE IS PROVIDED ``AS IS'' AND ANY EXPRESS OR IMPLIED WARRANTIES,
//  INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY
//  AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL
//  THE AUTHORS OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
//  SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED
//  TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
//  PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF
//  LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
//  NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE,
//  EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
//

const createScript          = require("vm").createScript
    , join                  = require("path").join
    , normalize             = require("path").normalize
    , dirname               = require("path").dirname
    , basename              = require("path").basename;

const slice                 = Array.prototype.slice;

const NIL                   = {};

const WRAPPER_TMPL          = "with (__props) {%s;\n}";

const REQUIRED_RE           = /^[A-Z]*$/
    , RESERVED_NAMES_RE     = /^(end|include|define)$/
    , PARAM_REQUIRED_RE     = /^(struct|section|expression|custom)/
    , BYTESIZE_RE           = /^([\d\.]+)(b|kb|mb|gb)$|^([\d\.]+)$/
    , TIMEUNIT_RE           = /^([\d\.]+)(ms|s|m|h|d)$|^([\d\.]+)$/;

const ESCAPE_CHARS          = "\\^$*+?.()|{}[]";

const NATIVE_TYPE_MAPPING   =
      [ Boolean, "boolean"
      , String, "string"
      , Number, "number"
      , Array, "array"
      , Object, "object"
      , RegExp, "regexp"
      ];

const PROPERTY_TYPES        =
      [ "boolean"
      , "string"
      , "number"
      , "array"
      , "object"
      , "regexp"
      , "section"
      , "expression"
      , "path"
      , "static"
      , "struct"
      , "wildcard"
      , "custom"
      , "bytesize"
      , "timeunit"
      ];


exports.createContext = function(markup) {
  var context = new ConfigContext();

  if (!markup) {
    throw new Error("Expected 'markup'.");
  }

  updateSection(context, markup);

  return context;
};


exports.createScript = function(code, filename) {
  var script;
  script  = new Script(code, filename);
  return script;
};


exports.validateValue = function(type, value, strict) {
  var fakefield;
  var param;

  if (typeof type == "undefined") {
    throw new Error("bad argument, `type`, expected type");
  }

  if (typeof type == "function") {
    fakefield = { type: "custom", param: type,  strict: strict || false };
  } else {
    fakefield = { type: type, strict: strict || false };
  }

  try {
    return validateValue.call(null, fakefield, value);
  } catch (validationError) {
    throw new Error(validationError.message);
  }
};


function Script(code, filename) {
  this.code = code
  this.filename = filename
  this.workdir = process.cwd();
  this.strict = false;
  this.paths = [];
  this.isolated = false;
  this.globals = null;
}

Script.prototype.runInContext = function(context, env) {
  var globals = this.globals || {};
  var sandbox;
  var runtime;
  var result;

  if (!context || !context instanceof ConfigContext) {
    throw new Error("Expected a ConfigContext as context");
  }

  runtime = new Runtime(this,
                        context,
                        this.workdir,
                        this.paths,
                        this.strict,
                        this.isolated,
                        globals);


  sandbox = createSandbox(runtime, env || {});

  runtime.push(context);

  runScript(runtime, sandbox, this.code, this.filename);

  while ((result = runtime.pop()) && runtime.currentScope);

  return result;
};


// define command implementation
function defineImpl(name, markup) {
  var sectionmarkup = {};
  var runtime;
  var sandbox;
  var context;

  if (this instanceof Runtime) {
    runtime = this;
  } else {
    runtime = this[0];
    sandbox = this[1];
  }

  context = runtime.context;

  if (typeof context[name] !== "undefined") {
    throw new RuntimeError(runtime, "already defined");
  }

  sectionmarkup[name] = markup;

  try {
    updateSection(context, sectionmarkup);
  } catch (updateError) {
    throw new RuntimeError(runtime, updateError.message);
  }

  if (sandbox) {
    defineProperties(runtime, context.props, sandbox.__props);
  }
}


function defineProperties(runtime, properties, target) {
  var namespace;
  var property;

  for (var name in properties) {
    property = properties[name];

    if (typeof property == "object") {
      // Special case, namespace. We need to rebuild this
      // each time, to keep it updated.
      defineProperties(runtime, property, (namespace = {}));
      target[name] = namespace;
    } else {
      if (name in target == false) {
        property = property.bind(runtime);
        Object.defineProperty(target, name, {
          enumerable: true, get: property, set: property
        });
      }
    }
  }
}


// Include command implementation
function includeImpl(filename) {
  var self = this;
  var env = typeof arguments[1] === "object" && arguments[1] || {};
  var isolated = env && arguments[2] || arguments[1];
  var resolvedPath;
  var script;
  var sandbox;
  var runtime;

  resolvedPath = this.resolvePath(filename, true);

  if (resolvedPath == null) {
    throw new RuntimeError(this, "Include not found '" + filename + "'");
  }

  if (!Array.isArray(resolvedPath)) {
    resolvedPath = [resolvedPath];
  }

  resolvedPath.forEach(function(p) {
    var msg;
    var code;

    try {
      code = require("fs").readFileSync(p, "utf8");
    } catch (ioException) {
      throw new RuntimeError(self, msg);
    }

    script = new Script(code, basename(p));
    script.workdir = dirname(p);

    runtime = new Runtime(script,
                          self.context,
                          script.workdir,
                          self.paths,
                          self.strict,
                          self.isolated || isolated,
                          self.globals);

    runtime.copy(self);

    sandbox = createSandbox(runtime, env || {});

    runScript(runtime, sandbox, script.code, script.filename);

    self.copy(runtime);
  });
}


// Runtime
function Runtime(script, context, workdir, paths, strict, isolated, globals) {
  this.script = script;
  this.context = context;
  this.workdir = workdir;
  this.paths = paths;
  this.strict = strict;
  this.isolated = isolated;
  this.globals = globals;

  this.resultStack = [];
  this.currentResult = null;

  this.scopeStack = [];
  this.currentScope = null;

  this.indexStack = [];
  this.currentIndex = null;
}

Runtime.prototype.define = defineImpl;

// Copy a runtime variables from specified runtime
Runtime.prototype.copy = function(runtime) {
  this.resultStack = runtime.resultStack;
  this.currentResult = runtime.currentResult;
  this.scopeStack = runtime.scopeStack;
  this.currentScope = runtime.currentScope;
  this.indexStack = runtime.indexStack;
  this.currentIndex = runtime.currentIndex;
}

// Push scope to stack
Runtime.prototype.push = function(scope) {
  this.scopeStack.push(this.currentScope);
  this.currentScope = scope;
  this.indexStack.push(this.currentIndex);
  this.currentIndex = scope.index ? [] : null;
  this.resultStack.push(this.currentResult);
  this.currentResult = {};
  return this.currentResult;
}

// Pop scope from stack
Runtime.prototype.pop = function() {
  var result = this.currentResult;
  var scope = this.currentScope;
  var index = this.currentIndex;
  this.currentResult = this.resultStack.pop();
  this.currentScope = this.scopeStack.pop();
  this.currentIndex = this.indexStack.pop();
  endScope.call(this, scope, result, index);
  return result;
}

Runtime.prototype.resolvePath = function(path, enableWildcard) {
  var workdir = this.workdir;
  var paths = this.paths;
  var isolated = this.isolated;
  var wildcard = false;
  var result;
  var dirpath;
  var files;
  var pattern;

  if (isolated && (path[0] == "/" ||  /\.\.\//.test(path))) {
    return null;
  }

  if (/\*|\?/.test(basename(path))) {
    if (!enableWildcard) {
      throw new RuntimeError(this, "Wildcard matches is not supported");
    }
    wildcard = true;
  }

  function isKind(kind, path) {
    var stat;
    try {
      stat = require("fs").statSync(path);
      return kind == "dir" ? stat.isDirectory() : stat.isFile();
    } catch(e) {
      return false;
    }
    return true;
  }

  function resolveKind(kind, p) {
    var newpath;

    if (p[0] == "/") {
      return isKind(kind, p) && p || null;
    }

    if (path[0] == ".") {
      newpath = join(workdir, p);
      return isKind(kind, newpath) && newpath || null;
    }

    for (var i = 0, l = paths.length; i < l; i++) {
      newpath = join(paths[i], p);
      if (isKind(kind, newpath)) {
        return newpath;
      }
    }

    return null;
  }

  if (wildcard) {
    dirpath = resolveKind("dir", dirname(path));

    if (!dirpath) {
      return null;
    }

    try {
      files = require("fs").readdirSync(dirpath);
    } catch (listException) {
      return null;
    }

    pattern = wildcardPattern(basename(path));
    result = [];

    files.forEach(function(file) {
      var filepath = join(dirpath, file);
      if (pattern.test(file) && isKind("file", filepath)) {
        result.push(filepath);
      }
    })

    return result;
  } else {
    return resolveKind("file", path);
  }
}


function ConfigContext() {
  this.name = "[ROOT]";
  this.root = this;
  this.parent = null;
  this.fields = {};
  this.defaults = {};
  this.requirements = {};
  this.statics = {};
  this.field = null;
  this.index = null;

  this.props = {};
}


function RuntimeError(runtime, message, label) {
  var self = this;
  var script;
  var stack;
  var obj;
  var tmp;

  this.runtime = runtime;
  this.message = message;

  // Ugly little hack to get the stack as an Array instead
  // of just a formatted string.
  Error.captureStackTrace(this, RuntimeError);
  Error.prepareStackTrace = function(error, stack) {
    self._stack = stack;
  };

  // This will trigger prepareStackTrace, where we
  // can get the stack as a graph.
  tmp = this.stack;
  this.stack = null;

  Error.prepareStackTrace = null;

  // Capture once more, this will cause `toString` to
  // generate the stack-dump as string.
  Error.captureStackTrace(this, RuntimeError);

  if (typeof label == "string") {
    this.label = label;
  } else {

    if (!runtime || !runtime.script) {
      this.label = "unknown";
      return;
    }

    script = this.runtime.script;
    stack = this._stack;

    for (var i = 0; i < stack.length; i++) {
      obj = stack[i];

      if (obj.getTypeName() == "[object global]" &&
          obj.getEvalOrigin() == script.filename) {
        // Matched current script.
        this.label = [script.filename,
                      obj.getLineNumber(),
                      obj.getColumnNumber()].join(":");
      }
    }
  }

}

exports.RuntimeError = RuntimeError;
require("util").inherits(RuntimeError, Error);

RuntimeError.prototype.getSimpleMessage = function() {
  return this.message + " (" + this.label + ")";
};

// Kind of "hacky", but it works.
RuntimeError.fromNativeError = function(runtime, error) {
  var stack;
  var re;
  var m;

  if (typeof error == "object" && error.stack && runtime.script) {
    re = new RegExp("at\\s(" + runtime.script.filename + "\\:\\d+\\:\\d+)");
    stack = error.stack.split("\n");
    for (var i = 0, l = stack.length; i < l; i++) {
      if ((m = re.exec(stack[i]))) {
        return new RuntimeError(runtime, error.message || error.toString(),
                                         m[1]);
      }
    }
    return new RuntimeError(runtime, error.message || error.toString());
  } else {
    return new RuntimeError(runtime, error);
  }
};


// Run a script in sandbox
function runScript(runtime, sandbox, code, filename) {
  var wrapper = WRAPPER_TMPL.replace(/%s/g, code);
  var script = createScript(wrapper, filename);
  try {
    script.runInNewContext(sandbox);
  } catch (scriptError) {
    if (scriptError instanceof RuntimeError) {
      throw scriptError;
    } else if (typeof scriptError == "object" &&
               typeof scriptError.stack == "string") {
      throw RuntimeError.fromNativeError(runtime, scriptError);
    } else {
      throw new RuntimeError(runtime, scriptError &&
                                      scriptError.message ||
                                      "unknown runtime error");
    }
  }
}


// Create a new sandbox from runtime
// and optional enviroment variables
function createSandbox(runtime, env) {
  var sandbox = { __props : {} };
  var context = runtime.context;
  var globals = runtime.globals;
  var propfn;

  defineProperties(runtime, context.props, sandbox.__props);

  Object.defineProperty(sandbox.__props, "end", {
    get: (function() {
      var field = this.currentScope;
      var result = this.currentResult;

      if (typeof field.onexit == "function") {
        field.onexit(this, result);
      }

      this.pop();

    }).bind(runtime)
  });

  sandbox.include = includeImpl.bind(runtime);
  sandbox.define = defineImpl.bind([runtime, sandbox]);

  for (var name in env) {
    if (RESERVED_NAMES_RE.test(name)) {
      throw new Error("Environment property '" +  name + "' is reserved.");
    }
    sandbox[name] = env[name];
  }

  for (var key in globals) {
    if (RESERVED_NAMES_RE.test(key)) {
      throw new Error("Global property '" +  key + "' is reserved.");
    }
    sandbox[key] = globals[key];
  }

  return sandbox;
}


function getNamespace(target, expr) {
  var splitted = expr.split(".");
  var name = splitted.shift();
  var obj;

  if (name in target) {
    obj = target[name];
  } else {
    obj = target[name] = {};
  }

  return splitted.length ?  getNamespace(obj, splitted.join(".")) : obj;
}


// Update section with specified markup
function updateSection(scope, markup) {
  var root = scope.root;
  var keys;
  var name;
  var length;
  var field;
  var subscope;
  var ns;

  keys = Object.keys(markup);
  length = keys.length;

  for (var index = 0; index < length; index++) {
    name = keys[index];

    if (RESERVED_NAMES_RE.test(name)) {
      throw new Error("Name '" + name + "' is reserved.");
    }

    if (scope.fields[name] || scope.statics[name]) {
      throw new Error("Property '" + name + "' is already defined");
    }

    field = getPropertyField(name, markup[name]);

    if (field == null) {
      throw new Error("Property '" + name + "' cannot be null");
    }

    if (field.type == "static") {

      if (field.value == NIL) {
        throw new Error("Property '" + name + "', value of type " +
                        "static must be set");
      }

      scope.statics[name] = field.value;

      continue;
    }

    if (PARAM_REQUIRED_RE.test(field.type) && !field.param) {
      throw new Error("Property '" + name + "', `param` must be set for field.");
    }

    if (scope.type == "struct" && name !== scope.property) {
      throw new Error("Property '" + name + "', struct's cannot contain " +
                      "dynamic properties.");
    }

    if (field.value !== NIL) {
      scope.defaults[name] = field.value;
    }

    if (field.required) {
      scope.requirements[name] = field;
    }

    field.root = root;
    field.parent = scope;

    if (field.type === "section" || field.type == "struct") {
      field.fields = {};
      field.defaults = {};
      field.requirements = {};
      field.statics = {};

      updateSection(field, field.param);

      if (field.property) {

        if (typeof field.property !== "string") {
          throw new Error( "Property '" + name + "', expected a string "
                         + "value for section 'property'.");
        }
      }

      if (field.index) {
        if (typeof field.index !== "string") {
          throw new Error( "Property '" + name + "', expected a string "
                         + "value for section 'index'.");
        }
      }

    }

    ns = field.ns ? getNamespace(root.props, field.ns) : root.props;

    if (!ns[name]) {
      ns[name] = createProp(name, field.ns);
    }

    scope.fields[name] = field;
  }
}


// Create a new property wrapper
function createProp(name, ns) {
  return function(value) {
    var args = slice.call(arguments);
    var scope = this.currentScope;
    var fullname;
    var field;
    var prop;

    fullname = ns ? [ns, name].join(".") : name;

    if (!scope || !scope.fields ||
        !(field = scope.fields[name])) {
      throw new Error( "Property '" + fullname + "' cannot be defined "
                     + "in section '" + (scope && scope.name || "<null>") + "'");
    }

    if (field.type == "section" || field.type == "struct") {
      this.push(field);

      if (field.property) {

        if (!(prop = field.fields[field.property])) {
          throw new Error( "Property '" + fullname + "', field not found: "
                         + field.property);
        }

        applyResult.call(this, prop, value);
      }

      if (typeof field.onenter == "function") {
        field.onenter(this, this.currentResult);
      }

      if (field.type == "struct") {
        this.pop();
      }

    } else {

      return applyResult.call(this, field, value);
    }
  }
}


// Apply result to current result set
function applyResult(field, value) {
  var name = field.name;
  var result = this.currentResult;
  var index = !field.idxignore && this.currentIndex;
  var validated;

  if (typeof field.ns == "string") {
    result = getNamespace(result, field.ns);
  }

  if (field.list) {

    if (!(name in result)) {
      result[name] = [];
    }

    if (Array.isArray(value)) {
      for (var i = 0; i < value.length; i++) {
        validated = validateValue.call(this, field, value[i]);
        result[name].push(validated);
        index && (index[index.length] = validated);
      }
    } else {
      validated = validateValue.call(this, field, value);
      result[name].push(validated);
      index && (index[index.length] = validated);
    }

  } else if (field.overridable == false && (name in result)) {
    throw new RuntimeError(this, "Expected one value only");
  } else {
    validated = validateValue.call(this, field, value);
    result[name] = validated
    index && (index[index.length] = validated);
  }

  return validated;
}


// End scope
function endScope(scope, result, index) {
  var self = this;
  var target;
  var defvalue;
  var keys;
  var key;
  var length;
  var field;

  if (!scope) {
    throw new RuntimeError(this, "bad syntax, unexpected `end`");
  }

  keys = Object.keys(scope.fields);
  length = keys.length;

  while (length--) {
    key = keys[length];
    field = scope.fields[key];
    target = field.ns ? getNamespace(result, field.ns) : result;

    if (!(key in target)) {
      if (key in scope.defaults) {
        if (field.list) {
          target[key] = [];
          if (Array.isArray(scope.defaults[key])) {
            scope.defaults[key].forEach(function(val) {
              var validated = validateValue.call(self, field, val);
              target[key].push(val);
              index && (index[index.length] = val);
            });
          } else {
            defvalue = scope.defaults[key];
            target[key].push(validateValue.call(self, field, defvalue));
          }
        } else {
          defvalue = scope.defaults[key];
          target[key] = validateValue.call(self, field, defvalue);
        }
      } else if (field.list && !field.required) {
        target[key] = [];
      }
    }
  }

  keys = Object.keys(scope.requirements);
  length = keys.length;

  while (length--) {
    key = keys[length];
    field = scope.requirements[key];
    target = field.ns ? getNamespace(result, field.ns) : result;
    if (!(key in target)) {
      throw new RuntimeError(self, "Required property '" + key + "'"
                                 + "was not set.");
    }
  }

  keys = Object.keys(scope.statics);
  length = keys.length;

  while (length--) {
    key = keys[length];
    result[key] = scope.statics[key];
  }

  if (scope.index) {
    result[scope.index] = index;
  }

  if (scope.parent) {
    applyResult.call(this, scope, result);
  }
}


// Get a struct from expression
function getPropertyField(name, expr) {
  var type = null;
  var required = false;
  var overridable = false;
  var list = false;
  var value = NIL;
  var param = null;
  var index = null;
  var property = null;
  var strict = false;
  var idxignore = false;
  var onenter = null;
  var onexit = null;
  var ns = null;
  var ctor;
  var i;

  if (typeof expr == "undefined" || expr == null) {
    return null;
  }

  if (Array.isArray(expr)) {
    if (typeof expr[0] === "string") {
      type = expr[0].toLowerCase();
      required = REQUIRED_RE.test(expr[0]) && true || false;
    } else if (expr[0].constructor === RegExp) {
      type = "expression";
      param = expr[0];
    } else if ((i = NATIVE_TYPE_MAPPING.indexOf(expr[0])) != -1) {
      type = NATIVE_TYPE_MAPPING[i + 1];
    } else if (typeof expr[0] == "function") {
      type = "custom";
      param = epxr[0];
    }
    if (expr.length > 1) {
      value = expr[1];
    }
    list = true;
  } else if (expr.constructor === RegExp) {
    type = "expression";
    param = expr;
  } else if (typeof expr === "string") {
    type = expr.toLowerCase();
    required = REQUIRED_RE.test(expr) && true || false;
  } else if ((i = NATIVE_TYPE_MAPPING.indexOf(expr)) != -1) {
    type = NATIVE_TYPE_MAPPING[i + 1];
  } else if (typeof expr == "function") {
    type = "custom";
    param = expr;
  } else {
    if (typeof expr.type === "string") {
      type = expr.type.toLowerCase();
      required = REQUIRED_RE.test(expr.type) && true || false;
    } else if (expr.type && expr.type.constructor === RegExp) {
      type = "expression";
      param = expr.type;
    } else if ((i = NATIVE_TYPE_MAPPING.indexOf(expr.type)) != -1) {
      type = NATIVE_TYPE_MAPPING[i + 1];
    } else if (expr.section) {
      type = "section";
      property = expr.property;
      param = expr.section;
      index = expr.index;
    } else if (expr.struct) {
      type = "struct";
      property = expr.property;
      param = expr.struct;
    } else if (expr.type && typeof expr.type == "function") {
      type = "custom";
      param = expr.type;
    }
    required = expr.required || (REQUIRED_RE.test(expr) && true || false);
    // value = "value" in expr && expr.value || NIL;

    if ("value" in expr) {
      value = expr.value;
    } else {
      value = NIL;
    }
    list = expr.list || false;
    param = param && param || expr.param;
    index = index && index || expr.index;
    strict = expr.strict || false;
    idxignore = expr.idxignore || false;
    overridable = expr.overridable || false;
    onenter = expr.onenter || null;
    onexit = expr.onexit || null;
    ns = expr.ns || null;
  }

  if (PROPERTY_TYPES.indexOf(type) == -1) {
    throw new Error("Property '" + name + "', unknown field type: " + type);
  }

  return {name: name,
          type: type,
          property: property,
          list: list,
          required: required,
          param: param,
          strict: strict,
          value: value,
          idxignore: idxignore,
          overridable: overridable,
          index: index,
          ns: ns,
          onenter: onenter,
          onexit: onexit };
}


// Validate value against struct
function validateValue(field, value) {
  var strict = this.strict || field.strict;
  var workdir = this.workdir;

  switch (field.type) {

    case "wildcard":
      return value;

    case "boolean":
      if (typeof value == "boolean") {
        return value;
      } else if (strict) {
        throw new RuntimeError(this, "Expected a Boolean");
      } else {
        return true;
      }
      break;

    case "string":
      if (typeof value == "string") {
        return value;
      } else if (strict) {
        throw new RuntimeError(this, "Expected a String");
      } else {
        return value.toString();
      }
      break;

    case "number":
      if (typeof value == "number") {
        return value;
      } else if (strict) {
        throw new RuntimeError(this, "Expected a Number");
      } else {
        if (isNaN(value = parseInt(value))) {
          throw new RuntimeError(this, "Expected a Number");
        }
        return value;
      }
      break;

    case "array":
      if (Array.isArray(value)) {
        return value;
      } else if (strict) {
        throw new RuntimeError(this, "Expected an Array");
      } else {
        return [value];
      }
      break;

    case "object":
      if (typeof value == "object") {
        return value;
      } else if (strict) {
        throw new RuntimeError(this, "Expected an Object");
      } else {
        return value;
      }
      break;

    case "regexp":
      if (value && value.constructor === RegExp) {
        return value;
      } else if (strict) {
        throw new RuntimeError(this, "Expected a RegExp");
      } else if (typeof value == "string") {
        try {
          return new RegExp(value);
        } catch (initExecption) {
          throw new RuntimeError(this, "Expected a RegExp");
        }
      } else {
        throw new RuntimeError(this, "Expected a RegExp");
      }
      break;

    case "expression":
      if (!field.param) {
        return NIL;
      }
      if (typeof value == "string") {
        if (field.param(value) == null) {
          throw new RuntimeError(this, "Bad value '" + value + "'");
        } else {
          return value;
        }
      } else if (strict) {
        throw new RuntimeError(this, "Expected a String");
      } else {
        value = value.toString();
        if (field.param(value) == null) {
          throw new RuntimeError(this, "Bad value '" + value + "'");
        } else {
          return value;
        }
      }
      break;

    case "path":
      if (typeof value == "string") {
        return resolvePath(value, workdir);
      } else if (strict) {
        throw new RuntimeError(this, "Expected a path");
      } else {
        return resolvePath(value.toString(), workdir);
      }
      break;

    case "bytesize":
      if (typeof value == "number") {
        return parseInt(value);
      } else if (typeof value == "string") {
        return getBytes.call(this, value);
      } else if (strict) {
        throw new RuntimeError(this, "Expected String or Number");
      } else {
        return getBytes.call(this, value.toString());
      }
      break;

    case "timeunit":
      if (typeof value == "number") {
        return parseInt(value);
      } else if (typeof value == "string") {
        return getMilliseconds.call(this, value);
      } else if (strict) {
        throw new RuntimeError(this, "Expected String or Number");
      } else {
        return getMilliseconds.call(this, value.toString());
      }
      break;

    case "custom":
      return field.param(field, value, this);
      break;
  }

  return value;
}

function getBytes(expr) {
  var m  = BYTESIZE_RE.exec(expr);

  if (!m) {
    throw new RuntimeError(this, "Invalid bytesize expression");
  }

  if (m[2]) {
    switch (m[2]) {
      case "b": return parseInt(m[1]);
      case "kb": return parseFloat(m[1]) * 1024;
      case "mb": return parseFloat(m[1]) * 1024 * 1024;
      case "gb": return parseFloat(m[1]) * 1024 * 1024 * 1024;
    }
  }

  return parseInt(m[3]);
}

function getMilliseconds(expr) {
  var m  = TIMEUNIT_RE.exec(expr);

  if (!m) {
    throw new RuntimeError(this, "Invalid timeunit expression");
  }

  if (m[2]) {
    switch (m[2]) {
      case "ms": return parseInt(m[1]);
      case "s": return parseFloat(m[1]) * 1000;
      case "m": return parseFloat(m[1]) * 1000 * 60;
      case "h": return parseFloat(m[1]) * 1000 * 60 * 60;
      case "d": return parseFloat(m[1]) * 1000 * 60 * 60 * 24;
    }
  }

  return parseInt(m[3]);
}

// Resolve path to file
function resolvePath(path, workdir) {
  switch (path[0]) {
    default:
    case "/": return path;
    case "~": return join(process.env["HOME"], path.substr(1));
    case ".": return join(workdir, path);
  }
}

function wildcardPattern(pattern) {
  var result = [];
  for (var i = 0; i < pattern.length; ++i) {
    var c = pattern.charAt(i);
    switch (c) {
      case '?':
        result.push(".");
        break;
      case '*':
        result.push(".*");
        break;
      default:
        if (ESCAPE_CHARS.indexOf(c) >= 0) {
          result.push("\\");
        }
        result.push(c);
      }
  }
  return new RegExp(result.join("") + "$");
}