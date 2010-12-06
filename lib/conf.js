/**
 *  ## Node-conf
 *
 *  Using JSON for configuration is great many times. But sometimes, you need
 *  to do more that just placing markup in a text file.
 *
 *  Node-conf tries to solve this by combinding an easy-to-read data design 
 *  pattern with good old javascript.
 *
 *  A quick example of a config file:
 *
 *      server
 *          hostname  = "127.0.0.1"
 *          port      = 80
 *
 *          location = "/articles"
 *              allow
 *          end
 *      end
 */
const createScript          = require("vm").createScript
    , readFileSync          = require("fs").readFileSync
    , normalize             = require("path").normalize
    , dirname               = require("path").dirname
    , basename              = require("path").basename;

const slice                 = Array.prototype.slice;

const NIL                   = {};

const WRAPPER_TMPL          = "with (__props) {%s;\n}";

const REQUIRED_RE           = /^[A-Z]*$/;

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
      ];

const RESERVED_NAMES        =
      [ "end"
      , "include"
      ];

/**
 *  ### conf.createContext(markup)
 *
 *  Construct a new config context object. The config context is then used
 *  to run a config script.
 *
 *  The `markup` is a data graph, that is used to describe the config script
 *  layout. A simple example:
 *
 *      var conf = require("conf");
 *      conf.createContext({
 *        host: { type: String, value: "localhost" },
 *        port: { type: Number, value: 8080}
 *      });
 *
 *  The first key, `host`, represents a String property with default 
 *  value `"localhost"`. The second key, `port`, represents a Number property
 *  with default value `8080`.
 *
 *  A valid config script would look like follows:
 *
 *      host = "10.0.0.1"
 *      port = 80
 *
 *
 *  There is 10 different property types, each with it's set 
 */
exports.createContext = function(markup) {
  var context = new ConfigContext();
  
  if (!markup) {
    throw new Error("Expected 'markup'.");
  }
  
  updateSection(context, markup);

  return context;
}


/**
 *  ## createScript(path, [filename])
 *
 *  Creates a new ConfigScript from specified path.
 */
exports.createScript = function(path, filename) {
  var resolvedPath;
  var script;
  
  resolvedPath = resolvePath(dirname(process.argv[1]), path);
  script  = new ConfigScript(resolvedPath, filename);
  
  return script;
}


/**
 *  ## ConfigScript
 *
 *  Represents a ConfigScript.
 */
function ConfigScript(path, filename) {
  this.code = readFileSync(path, "utf8");
  this.filename = filename || basename(path);
  this.workdir = dirname(path);
  this.strict = false;
}

/**
 *  ### ConfigScript.runInContext(context, [env])
 *
 *  
 */
ConfigScript.prototype.runInContext = function(context, env) {
  var sandbox;
  var runtime;
  var result;
  
  if (!context || !context instanceof ConfigContext) {
    throw new Error("Expected a ConfigContext as context");
  }
  
  runtime = new Runtime(context, this.workdir, this.strict);
  
  sandbox = createSandbox(runtime, env || {});

  runtime.push(context);
  
  runScript(sandbox, this.code, this.filename);
  
  while ((result = runtime.pop()) && runtime._currentScope);
  
  return result;
}


// Runtime
function Runtime(context, workdir, strict) {
  this.context = context;
  this.workdir = workdir;
  this.strict = strict;

  this._resultStack = [];
  this._currentResult = null;

  this._scopeStack = [];
  this._currentScope = null;

  this._indexStack = [];
  this._currentIndex = null;
}

// Copy a runtime variables from specified runtime
Runtime.prototype.copy = function(runtime) {
  this._resultStack = runtime._resultStack;
  this._currentResult = runtime._currentResult;
  this._scopeStack = runtime._scopeStack;
  this._currentScope = runtime._currentScope;
  this._indexStack = runtime._indexStack;
  this._currentIndex = runtime._currentIndex;
}

// Push scope to stack
Runtime.prototype.push = function(scope) {
  this._scopeStack.push(this._currentScope);
  this._currentScope = scope;
  this._indexStack.push(this._currentIndex);
  this._currentIndex = scope._index ? [] : null;
  this._resultStack.push(this._currentResult);
  return this._currentResult = {};
}

// Pop scope from stack
Runtime.prototype.pop = function() {
  var result = this._currentResult;
  var scope = this._currentScope;
  var index = this._currentIndex;
  this._currentResult = this._resultStack.pop();
  this._currentScope = this._scopeStack.pop();
  this._currentIndex = this._indexStack.pop();
  endScope.call(this, scope, result, index);
  return result;
}


/**
 *  ## ConfigContext
 *
 *
 */
function ConfigContext() {
  this._name = "[ROOT]";
  this._root = this;
  this._parent = null;
  this._fields = {};
  this._defaults = {};
  this._requirements = {};
  this._statics = {};
  this._field = null;
  this._index = null;
                
  this._props = {};
}


// Include command implementation
function includeImpl(filename, env) {
  var resolvedPath = resolvePath(this.workdir, filename);
  var script;
  var sandbox;
  var runtime;
  
  try {
    script = new ConfigScript(resolvedPath);
  } catch (ioException) {
    throw new Error("conf: Could not include config script '" + 
                    resolvedPath  + "'.");
  }

  runtime = new Runtime(this.context, script.workdir, this.strict);
  runtime.copy(this);
  
  sandbox = createSandbox(runtime, env || {});  
  
  runScript(sandbox, script.code, script.filename);  
  
  this.copy(runtime);
}


// Run a script in sandbox
function runScript(sandbox, code, filename) {
  var script = createScript(WRAPPER_TMPL.replace(/%s/g, code), filename);
  script.runInNewContext(sandbox);
}


// Create a new sandbox from runtime 
// and optional enviroment variables
function createSandbox(runtime, env) {
  var sandbox = { __props : {} };
  var context = runtime.context;
  var propfn;

  for (var name in context._props) {
    propfn = context._props[name].bind(runtime);
    Object.defineProperty(sandbox.__props, name, {
      get: propfn, set: propfn
    });
  }
  
  Object.defineProperty(sandbox.__props, "end", {
    get: (function() { this.pop() }).bind(runtime)
  });
  
  sandbox.include = includeImpl.bind(runtime);
  
  for (var name in env) {
    if (RESERVED_NAMES.indexOf(name) !== -1) {
      throw new Error("conf: Cannot define environment " +
                      "variable, name '" +  name + "' is reserved.");
    }
    sandbox[name] = env[name];
  }
  
  return sandbox;
}


// Update section with specified markup
function updateSection(scope, markup) {
  var root = scope._root;
  var keys;
  var name;
  var length;
  var field;
  var subscope;
  
  keys = Object.keys(markup);
  length = keys.length;
  
  for (var index = 0; index < length; index++) { 
    name = keys[index];
    
    if (RESERVED_NAMES.indexOf(name) != -1) {
      throw new Error("conf: '" + name + "' is reserved.");
    }
    
    if (scope._fields[name] || scope._statics[name]) {
      throw new Error("conf: Property is already defined '" + name + "'");
    }

    field = getPropertyField(markup[name]);
    
    if (field == null) {
      throw new Error("conf[" + name + "]: Property cannot be null");
    }
    
    if (field.type == "static") {
    
      if (field.value == NIL) {
        throw new Error("conf[" + name + "]: " +
                        "Value of type static must be set");
      }
      
      scope._statics[name] = field.value;
      
      continue;
    }
    
    if (scope.type == "struct" && name !== scope.property) {
      throw new Error("conf[" + name + "]:" + 
                      "Struct's cannot contain dynamic properties.");
    }

    if (field.value !== NIL) {
      scope._defaults[name] = field.value;
    }

    if (field.required) {
      scope._requirements[name] = true;
    }

    if (field.list && !field.required && field.value === NIL) {
      scope._defaults[name] = [];
    }

    if (field.type === "section" || field.type == "struct") {
      field._name = name;
      field._root = root;
      field._parent = scope;
      field._fields = {};
      field._defaults = {};
      field._requirements = {};
      field._statics = {};

      updateSection(field, field.param);
      
      if (field.property) {

        if (typeof field.property !== "string") {
          throw new Error( "conf-markup[" + name + "]: Expected a string "
                         + "value for section 'property'.");
        }        
      }
      
      if (field._index) {
        if (typeof field._index !== "string") {
          throw new Error( "conf-markup[" + name + "]: Expected a string "
                         + "value for section 'idnex'.");
        }        
      }
              
    } 
    
    if (!root._props[name]) {
      root._props[name] = createProp(name);      
    }

    scope._fields[name] = field;
  }
}


// Create a new property wrapper
function createProp(name) {
  return function(value) {
    var args = slice.call(arguments);
    var scope = this._currentScope;
    var field;
    var prop;

    if (!scope || !scope._fields || 
        !(field = scope._fields[name])) {
      throw new Error("conf: Property '" + name + "' cannot be defined in..");
    }
    
    if (field.type == "section" || field.type == "struct") {
      this.push(field);

      if (field.property) {

        if (!(prop = field._fields[field.property])) {
          throw new Error("conf: Property field not found: " + field.property);
        }

        applyResult.call(this, field.property, value, prop);
      }

      if (field.type == "struct") {
        this.pop();
      }
    } else {
      return applyResult.call(this, name, value, field);
    }
  }
}


// Apply result to current result set
function applyResult(name, value, field) {
  var result = this._currentResult;
  var index = this._currentIndex;
  var validated;

  if (field.list) {
    
    if (!(name in result)) {
      result[name] = [];
    }
    
    if (Array.isArray(value)) {
      for (var i = 0; i < value.length; i++) {
        validated = validateValue.call(this, name, value[i], field);
        result[name].push(validated);
        index && (index[index.length] = validated);
      }
    } else {
      validated = validateValue.call(this, name, value, field);
      result[name].push(validated);
      index && (index[index.length] = validated);
    }


  } else if (name in result) {
    throw new Error("conf[" + name + "]: Expected one value only");
  } else {
    validated = validateValue.call(this, name, value, field);
    result[name] = validated
    index && (index[index.length] = validated);
  }

  return result[name];
}


// End scope
function endScope(scope, result, index) {
  var keys;
  var key;
  var length;
  
  keys = Object.keys(scope._defaults);
  length = keys.length;
  
  while (length--) {
    key = keys[length];
    if (!(key in result)) {
      result[key] = scope._defaults[key];
      index && (index[index.length] = scope._defaults[key]);
    }
  }

  keys = Object.keys(scope._requirements);
  length = keys.length;
  
  while (length--) {
    key = keys[length];
    if (!(key in result)) {
      throw new Error("conf: Required property '" + key + "' was not set.");
    }
  }

  keys = Object.keys(scope._statics);
  length = keys.length;
  
  while (length--) {
    key = keys[length];
    result[key] = scope._statics[key];
  }
  
  if (scope._index) {
    result[scope._index] = index;
  }
  
  if (scope._parent) {
    applyResult.call(this, scope._name, result, scope);
  }
}


// Get a struct from expression
function getPropertyField(expr) {
  var type = null;
  var required = false;
  var list = false;
  var value = NIL;
  var param = null;
  var index = null;
  var property = null;
  var strict = false;
  var ctor;
  var i;
  
  if (typeof expr == "undefined" || expr == null) {
    return null;
  }

  if (Array.isArray(expr)) {
    if (typeof expr[0] === "string") {
      type = expr[0].toLowerCase();
      required = REQUIRED_RE(expr[0]) && true || false; 
    } else if (expr[0].constructor === RegExp) {
      type = "expression";
      param = expr[0];
    } else if ((i = NATIVE_TYPE_MAPPING.indexOf(expr)) != -1) {
      type = NATIVE_TYPE_MAPPING[i + 1];
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
    required = REQUIRED_RE(expr) && true || false;
  } else if ((i = NATIVE_TYPE_MAPPING.indexOf(expr)) != -1) {
    type = NATIVE_TYPE_MAPPING[i + 1];
  } else {
    if (typeof expr.type === "string") {
      type = expr.type.toLowerCase();
      required = REQUIRED_RE(expr.type) && true || false; 
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
    }
    required = expr.required || (REQUIRED_RE(expr) && true || false);
    value = "value" in expr && expr.value || NIL; 
    list = expr.list || false;
    param = param && param || expr.param;
    strict = expr.strict || false;
  }
  
  if (PROPERTY_TYPES.indexOf(type) == -1) {
    throw new Error("conf: Unknown property type: " + type);
  }
  
  return {
    type: type,
    property: property,
    list: list,
    required: required,
    param: param,
    strict: strict,
    value: value,
    _index: index
  }
}

// Validate value against struct
function validateValue(name, value, field) {
  var strict = this.strict || field.strict;
  var workdir = this.workdir;

  switch (field.type) {
    case "boolean":
      if (typeof value == "boolean") {
        return value;
      } else if (strict) {
        throw new Error("conf[" + name + "]: Expected a Boolean");
      } else {
        return true;
      }
      break;

    case "string":
      if (typeof value == "string") {
        return value;
      } else if (strict) {
        throw new Error("conf[" + name + "]: Expected a String");
      } else {
        return value.toString();
      }
      break;
      
    case "number":
      if (typeof value == "number") {
        return value;
      } else if (strict) {
        throw new Error("conf[" + name + "]: Expected a Number");
      } else {
        return parseInt(value);
      }
      break;

    case "array":
      if (Array.isArray(value)) {
        return value;
      } else if (strict) {
        throw new Error("conf[" + name + "]: Expected an Array");
      } else {
        return [value];
      }
      break;
      
    case "object":
      if (typeof value == "object") {
        return value;
      } else if (strict) {
        throw new Error("conf[" + name + "]: Expected an Object");
      } else {
        return value;
      }
      break;
      
    case "regexp":
      if (value && value.constructor === RegExp) {
        return value;
      } else if (strict) {
        throw new Error("conf[" + name + "]: Expected a RegExp");
      } else if (typeof value == "string") {
        try {
          return new RegExp(value);
        } catch (initExecption) {
          throw new Error("conf[" + name + "]: Expected a RegExp");
        }
      } else {
        throw new Error("conf[" + name + "]: Expected a RegExp");
      }
      break;
      
    case "expression":
      if (!field.param) {
        return NIL;
      }
      if (typeof value == "string") {
        if (field.param(value) == null) {
          throw new Error("conf[" + name + "]: Bad value '" + value + "'");
        } else {
          return value;
        }
      } else if (strict) {
        throw new Error("conf[" + name + "]: Expected a String");
      } else {
        value = value.toString();
        if (field.param(value) == null) {
          throw new Error("conf[" + name + "]: Bad value '" + value + "'");
        } else {
          return value;
        }
      }
      break;
      
    case "path":
      if (typeof value == "string") {
        return resolvePath(workdir, value);
      } else if (strict) {
        throw new Error("conf[" + name + "]: Expected a path");
      } else {
        return resolvePath(workdir, value.toString());
      }
      break;
  }
  
  return value;
}

// Resolve path to file
function resolvePath(dirpath, path) {
  if (path[0] == '/') {
    return path;
  }
  if (path.substring(0, 2) == "./") {
    return normalize(normalize(dirpath + "/" + path.substr(2)));
  } 
  if (path.substring(0, 3) == "../") {
    return normalize(normalize(dirpath + "/" + path));
  } 
  return path;
}

/**
 *  ## License
 *
 *  BSD-License.
 *
 *  Copyright (c) Johan Dahlberg 2010 
 */