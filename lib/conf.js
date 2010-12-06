/**
 *  # Node-conf
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

const STRUCT_TYPES          = 
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
      ];

const RESERVED_NAMES        =
      [ "end"
      , "include"
      ];

/**
 *  ## createContext(markup)
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
  
  console.log("dir: %s", this.workdir);
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
  this._struct = null;
  this._index = null;
                
  this._fieldProps = {};
  this._sectionProps = {};
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
  var proplists = [context._fieldProps, context._sectionProps];
  var propfn;

  proplists.forEach(function(proplist) {
    for (var name in proplist) {
      propfn = proplist[name].bind(runtime);
      Object.defineProperty(sandbox.__props, name, {
        get: propfn, set: propfn
      });
    }
  });
  
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
  var struct;
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

    struct = getPropertyStruct(markup[name]);
    
    if (struct == null) {
      throw new Error("conf[" + name + "]: Property cannot be null");
    }
    
    if (struct.type == "static") {
    
      if (struct.value == NIL) {
        throw new Error("conf[" + name + "]: " +
                        "Value of type static must be set");
      }
      
      scope._statics[name] = struct.value;
      
      continue;
    }

    if (struct.value !== NIL) {
      scope._defaults[name] = struct.value;
    }

    if (struct.required) {
      scope._requirements[name] = true;
    }

    if (struct.list && !struct.required && struct.value === NIL) {
      scope._defaults[name] = [];
    }

    if (struct.type === "section") {
      struct._name = name;
      struct._root = root;
      struct._parent = scope;
      struct._fields = {};
      struct._defaults = {};
      struct._requirements = {};
      struct._statics = {};

      updateSection(struct, struct.param);
      
      if (struct.property) {

        if (typeof struct.property !== "string") {
          throw new Error( "conf-markup[" + name + "]: Expected a string "
                         + "value for section 'property'.");
        }        
      }
      
      if (struct._index) {
        if (typeof struct._index !== "string") {
          throw new Error( "conf-markup[" + name + "]: Expected a string "
                         + "value for section 'idnex'.");
        }        
      }
      
      if (!root._sectionProps[name]) {
        
        if (root._fieldProps[name]) {
          throw new Error("Cannot define a section with same name as a field");
        }
        
        root._sectionProps[name] = createSectionProp(name);
      }
              
    } else {

      if (!root._fieldProps[name]) {

        if (root._sectionProps[name]) {
          throw new Error("Cannot define a field with same name as a section");
        }

        root._fieldProps[name] = createFieldProp(name);
      }
    }
    
    scope._fields[name] = struct;
  }
}


// Create a new section property wrapper
function createSectionProp(name) {
  return function(value) {
    var args = slice.call(arguments);
    var scope = this._currentScope;
    var struct;
    var prop;

    if (!scope || !scope._fields || 
        !(struct = scope._fields[name])) {
      throw new Error("conf: Property '" + name + "' cannot be defined in..");
    }

    this.push(struct);
    
    if (struct.property) {
      
      if (!(prop = struct._fields[struct.property])) {
        throw new Error("conf: Property field not found: " + struct.property);
      }

      applyResult.call(this, struct.property, value, prop);
    }
  }
}


// Create a new field property wrapper
function createFieldProp(name) {
  return function(value) {
    var scope = this._currentScope;
    var struct;
    
    if (!scope || !scope._fields || 
        !(struct = scope._fields[name])) {
      throw new Error("conf: Property '" + name + "' cannot be defined in..");
    }
    
    return applyResult.call(this, name, value, struct);
  }
}


// Apply result to current result set
function applyResult(name, value, struct) {
  var result = this._currentResult;
  var index = this._currentIndex;
  var validated;

  if (struct.list) {
    
    if (!(name in result)) {
      result[name] = [];
    }
    
    if (Array.isArray(value)) {
      for (var i = 0; i < value.length; i++) {
        validated = validateValue.call(this, name, value[i], struct);
        result[name].push(validated);
        index && (index[index.length] = validated);
      }
    } else {
      validated = validateValue.call(this, name, value, struct);
      result[name].push(validated);
      index && (index[index.length] = validated);
    }


  } else if (name in result) {
    throw new Error("conf[" + name + "]: Expected one value only");
  } else {
    validated = validateValue.call(this, name, value, struct);
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
function getPropertyStruct(expr) {
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
      type = expr[0];
    } else if (expr[0].constructor === RegExp) {
      type = "expression";
      param = expr[0];
    } else if ((i = NATIVE_TYPE_MAPPING.indexOf(expr)) != -1) {
      type = NATIVE_TYPE_MAPPING[i + 1];
    }
    if (expr.length > 1) {
      value = expr[2];
    }
    list = true;
  } else if (expr.constructor === RegExp) {
    type = "expression";
    param = expr;    
  } else if (typeof expr === "string") {
    type = expr;
    required = REQUIRED_RE(expr) && true || false; 
  } else {
    if (typeof expr.type === "string") {
      type = expr.type;
    } else if (expr.type && expr.type.constructor === RegExp) {
      type = "expression";
      param = expr.type;
    } else if ((i = NATIVE_TYPE_MAPPING.indexOf(expr)) != -1) {
      type = NATIVE_TYPE_MAPPING[i + 1];
    } else if (expr.section) {
      type = "section";
      property = expr.property;
      param = expr.section;
      index = expr.index;
    }
    required = expr.required || (REQUIRED_RE(expr) && true || false);
    value = "value" in expr && expr.value || NIL; 
    list = expr.list || false;
    parma = param && param || expr.param;
    strict = expr.strict || false;
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
function validateValue(name, value, struct) {
  var strict = this.strict || struct.strict;
  var workdir = this.workdir;

  switch (struct.type) {
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
      if (!struct.param) {
        return NIL;
      }
      if (typeof value == "string") {
        if (struct.param(value) == null) {
          throw new Error("conf[" + name + "]: Bad value '" + value + "'");
        } else {
          return value;
        }
      } else if (strict) {
        throw new Error("conf[" + name + "]: Expected a String");
      } else {
        value = value.toString();
        if (struct.param(value) == null) {
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