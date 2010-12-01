// 
//        Copyright 2010 Johan Dahlberg. All rights reserved.
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
//  NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS 
//  SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
//
const createScript              = require("vm").createScript
    , readFileSync              = require("fs").readFileSync
    , normalize                 = require("path").normalize
    , dirname                   = require("path").dirname
    , basename                  = require("path").basename;

const slice                     = Array.prototype.slice;

// Special types
const Section                   = {}
    , Path                      = {}
    , Choice                    = {};

const NIL                       = {};

const WRAPPER_TMPL              = "with (__props) {%s;\n}";


/**
 *  ## createContext()
 */
exports.createContext = function(markup) {
  var context = new ConfigContext();
  if (markup) {
    context.applyMarkup(markup);
  }
  return context;
}


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
 *  ### ConfigScript.runInContext(context)
 *
 *  
 */
ConfigScript.prototype.runInContext = function(context) {
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
  
  script = createScript( WRAPPER_TMPL.replace(/%s/g, this.code)
                       , this.filename);

  runtime.push(context);
  
  script.runInNewContext(sandbox);
  
  while ((result = runtime.pop()) && runtime._currentScope);
  
  return result;
}

function Runtime(context, workdir, strict) {
  this.context = context;
  this.workdir = workdir;
  this.strict = strict;

  this._resultStack = [];
  this._currentResult = null;

  this._scopeStack = [];
  this._currentScope = null;
}

Runtime.prototype.push = function(scope) {
  console.log("push %s", scope._name);
  this._scopeStack.push(this._currentScope);
  this._currentScope = scope;
  this._resultStack.push(this._currentResult = {});
  return this._currentResult;
}

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

/**
 *  ### ConfigContext.define(...)
 *
 *  Defines one ore more constants in the ConfigContext. 
 *
 *  Here is an example:
 *
 *      var context = createContext();
 *      context.define("VERSION_1", "DEBUG", "USE_SSL");
 *
 *
 *  The defined constants can now be used in the configuration.
 *
 *      if (typeof DEBUG) {
 *        // Do something if DEBUG is set.
 *      }
 */
ConfigContext.prototype.define = function() {
  var index = arguments.length;
  while (index--) {
    if (typeof arguments[index] !== "string") {
      throw new Error("argument[" + index + "]: Excepted a string");
    }
    this._constants[arguments[index]] = true;
  }
}

/**
 *  ### ConfigContext.applyMarkup()
 */
ConfigContext.prototype.applyMarkup = function(markup)  {
  updateSection(this, markup);
}

function updateSection(scope, markup) {
  var root = scope._root;
  var struct;
  var field;
  var subscope;
  
  for (var name in markup) {
    
    if (scope._fields[name]) {
      throw new Error("conf: Property is already defined '" + name + "'");
    }

    struct = getPropertyStruct(name, markup[name]);
    
    if (struct.value !== NIL) {
      scope._defaults[name] = struct.value;
    }

    if (struct.required) {
      scope._requirements[name] = true;
    }

    if (struct.list && !struct.required && struct.value === NIL) {
      scope._defaults[name] = [];
    }

    if (struct.type === Section) {
      struct._name = name;
      struct._root = root;
      struct._parent = scope;
      struct._fields = {};
      struct._defaults = {};
      struct._requirements = {};
      
      updateSection(struct, struct.markup);
      
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

function createSectionProp(name) {
  return function(value) {
    var args = slice.call(arguments);
    var scope = this._currentScope;
    var struct;

    if (!scope || !scope._fields || 
        !(struct = scope._fields[name])) {
      throw new Error("conf: Property '" + name + "' cannot be defined in..");
    }

    this.push(struct);
    
    if (struct.index) {
      applyResult.call(this, struct.index, value, struct);
    }
  }
}

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

function getPropertyStruct(name, expr) {
  var ctor;
  
  if (typeof expr == "undefined" || expr == null) {
    throw new Error("conf[" + name + "]: Property cannot be null");
  }
  
  ctor = expr.constructor;
  
  if (expr === String) {
    return { type: String
           , list: false
           , required: false
           , value: NIL};
  } else if (expr === Number) {
    return { type: Number
           , list: false
           , required: false
           , value: NIL};
  } else if (expr === Array) {
    return { type: Array
           , list: false
           , required: false
           , value: NIL};
  } else if (expr === Object) {
    return { type: Object
           , list: false
           , required: false
           , value: NIL};
  } else if (ctor === RegExp) {
    return { type: RegExp
           , list: false
           , required: false
           , expr: expr
           , value: NIL};
  } else if (expr === "path") {
    return { type: Path
           , list: false
           , required: false
           , value: NIL};
   } else if (expr === "PATH") {
     return { type: Path
            , list: false
            , required: true
            , value: NIL};
   } else if (expr === "string") {
     return { type: String
            , list: false
            , required: false
            , value: NIL};
  } else if (expr === "STRING") {
     return { type: String
            , list: false
            , required: true
            , value: NIL};
  } else if (expr === "number") {
     return { type: Number
            , list: false
            , required: false
            , value: NIL};
  } else if (expr === "NUMBER") {
     return { type: Number
            , list: false
            , required: true
            , value: NIL};
  } else if (Array.isArray(expr) && expr.length == 1 && expr[0] == String) {
    return { type: String
           , list: true
           , required: false
           , value: NIL};
  } else if (Array.isArray(expr) && expr.length == 1 && expr[0] == Number) {
    return {type: Number
           , list: true
           , required: false
           , value: NIL};
  } else if (Array.isArray(expr) && expr.length == 1 && expr[0] == Array) {
    return { type: Array
           , list: true
           , required: false
           , value: NIL};
  } else if (Array.isArray(expr) && expr.length == 1 && expr[0] == Object) {
    return { type: Object
           , list: true
           , required: false
           , value: NIL};

  } else if (Array.isArray(expr) && expr.length == 1 && ctor === RegExp) {
    return { type: RegExp
           , list: true
           , required: false
           , value: NIL};

  } else if (Array.isArray(expr) && expr.length == 1 && expr[0] === "path") {
    return { type: Path
           , list: true
           , required: false
           , value: NIL};
  } else {
    if (expr.section) {
      return { type: Section
             , list: expr.list || false
             , required: expr.required || false
             , index: expr.index
             , markup: expr.section
             , value: "value" in expr ? expr.value : NIL};
    } else if (expr.type && expr.type.constructor === RegExp) {
      return { type: RegExp
             , list: expr.list || false
             , required: expr.required || false
             , expr: expr.type
             , value: "value" in expr ? expr.value : NIL};
    } else if (expr.type && expr.type === "path") {
      return { type: Path
             , list: expr.list || false
             , required: expr.required || false
             , value: "value" in expr ? expr.value : NIL};
    } else if (expr.type && expr.type === "PATH") {
      return { type: Path
             , list: expr.list || false
             , required: expr.required || true
             , value: "value" in expr ? expr.value : NIL};
    } else if (expr.type && expr.type === "string") {
      return { type: String
             , list: expr.list || false
             , required: expr.required || false
             , value: "value" in expr ? expr.value : NIL};
    } else if (expr.type && expr.type === "STRING") {
      return { type: String
             , list: expr.list || false
             , required: expr.required || true
             , value: "value" in expr ? expr.value : NIL};
    } else if (expr.type && expr.type === "number") {
      return { type: Number
             , list: expr.list || false
             , required: expr.required || false
             , value: "value" in expr ? expr.value : NIL};
    } else if (expr.type && expr.type === "NUMBER") {
      return { type: Number
             , list: expr.list || false
            , required: expr.required || true
            , value: "value" in expr ? expr.value : NIL};
    } else if (!expr.type) {
      throw new Error("Expected 'type'");
    } else {
      return expr;
    }
  }
}

function validateValue(name, value, struct) {
  var strict = this.strict;
  var workdir = this.workdir;

  switch (struct.type) {
    case Number:
      if (typeof value == "number") {
        return value;
      } else if (strict) {
        throw new Error("conf[" + name + "]: Expected a number");
      } else {
        return parseInt(value);
      }
      break;

    case String:
      if (typeof value == "string") {
        return value;
      } else if (strict) {
        throw new Error("conf[" + name + "]: Expected a string");
      } else {
        return value.toString();
      }
      break;

    case Path:
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
