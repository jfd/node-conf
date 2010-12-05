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
  var script = new ConfigScript(path, filename);
  return script;
}


/**
 *  ## ConfigScript
 */
function ConfigScript(path, filename) {
  var resolvedpath = resolvePath(dirname(process.argv[1]), path);

  this.code = readFileSync(resolvedpath, "utf8");
  this.filename = basename(path);
  this.workdir = dirname(resolvedpath);
}

/**
 *  ### ConfigScript.runInContext(context, [env])
 *
 *  
 */
ConfigScript.prototype.runInContext = function(context, env) {
  var environment = env || {};
  var sandbox = { __props : {} };
  var proplists = [context._fieldProps, context._sectionProps];
  var runtime;
  var propfn;
  var script;
  var result;
  
  if (!context || !context instanceof ConfigContext) {
    throw new Error("Expected a ConfigContext as context");
  }
  
  runtime = new Runtime(context, this.workdir, false);
  
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
  
  for (var name in environment) {
    if (RESERVED_NAMES.indexOf(name) !== -1) {
      throw new Error("conf: Cannot define environment " +
                      "variable, name '" +  name + "' is reserved.");
    }
    sandbox[name] = environment[name];
  }
  
  script = createScript( WRAPPER_TMPL.replace(/%s/g, this.code)
                       , this.filename);

  runtime.push(context);
  
  script.runInNewContext(sandbox);
  
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
}

// Push scope to stack
Runtime.prototype.push = function(scope) {
  this._scopeStack.push(this._currentScope);
  this._currentScope = scope;
  this._resultStack.push(this._currentResult);
  return this._currentResult = {};
}

// Pop scope from stack
Runtime.prototype.pop = function() {
  var result = this._currentResult;
  var scope = this._currentScope;
  this._currentResult = this._resultStack.pop();
  this._currentScope = this._scopeStack.pop();
  endScope.call(this, scope, result);
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
  this._struct = null;
                
  this._fieldProps = {};
  this._sectionProps = {};
  this._constants = {};
}


// Update section with specified markup
function updateSection(scope, markup) {
  var root = scope._root;
  var struct;
  var field;
  var subscope;
  
  for (var name in markup) {
    
    if (RESERVED_NAMES.indexOf(name) != -1) {
      throw new Error("conf: '" + name + "' is reserved.");
    }
    
    if (scope._fields[name]) {
      throw new Error("conf: Property is already defined '" + name + "'");
    }

    struct = getPropertyStruct(markup[name]);

    if (struct == null) {
      throw new Error("conf[" + name + "]: Property cannot be null");
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
      
      updateSection(struct, struct.param);
      
      if (struct.index) {

        if (typeof struct.index !== "string") {
          throw new Error( "conf-markup[" + name + "]: Expected a string "
                         + "value for section property 'index'.");
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
    var index;

    if (!scope || !scope._fields || 
        !(struct = scope._fields[name])) {
      throw new Error("conf: Property '" + name + "' cannot be defined in..");
    }

    this.push(struct);
    
    if (struct.index) {
      
      if (!(index = struct._fields[struct.index])) {
        throw new Error("conf: Index field not found: " + struct.index);
      }

      applyResult.call(this, struct.index, value, index);
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

  if (struct.list) {
    
    if (!(name in result)) {
      result[name] = [];
    }
    
    if (Array.isArray(value)) {
      for (var i = 0; i < value.length; i++) {
        var validated = validateValue.call(this, name, value[i], struct);
        result[name].push(validated);
      }
    } else {
      result[name].push(validateValue.call(this, name, value, struct));
    }


  } else if (name in result) {
    throw new Error("conf[" + name + "]: Expected one value only");
  } else {
    result[name] = validateValue.call(this, name, value, struct);
  }

  return result[name];
}


// End scope
function endScope(scope, result) {
  
  for (var field in scope._defaults) {
    if (!(field in result)) {
      result[field] = scope._defaults[field];
    }
  }
  
  for (var field in scope._requirements) {
    if (!(field in result)) {
      throw new Error("conf: Required property '" + field + "' was not set.");
    }
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
      index = expr.index;
      param = expr.section
    }
    required = expr.required || (REQUIRED_RE(expr) && true || false);
    value = "value" in expr && expr.value || NIL; 
    list = expr.list || false;
    parma = param && param || expr.param;
    strict = expr.strict || false;
  }
  
  return {
    type: type,
    index: index,
    list: list,
    required: required,
    param: param,
    strict: strict,
    value: value
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