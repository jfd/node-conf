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
    , basename                  = require("path").basename


const slice                     = Array.prototype.slice

// Special types
const NIL                       = {};

const Section                   = {}
    , Path                      = {}
    , Choice                    = {}

const SANDBOX_PROPS             = [ "_fieldProps"
                                  , "_sectionProps"
                                  , "_constants"];

const ERROR_MESSAGES            = [
  "Property is already defined '%s'",
]

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


/**
 *  ## ConfigContext
 *
 *
 */
function ConfigContext() {
  var scope = { root: null
              , parent: null
              , fields: {}
              , result: {}
              , defaultValues: {}
              , requiredValues: {}
              , stack: []
              , strict: false
              , workdir: null };

  scope.root = scope;
  
  this._scope = scope;
                
  this._fieldProps = {};
  this._sectionProps = {};
  this._constants = {};
  
  this._currentScope = null;
  this._scopeStack = [];
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
 *  ### ConfigContext.getConfig(filepath)
 */
ConfigContext.prototype.parse = function(filepath)  {
  var self = this;
  var resolvedpath = resolvePath(dirname(process.argv[1]), filepath);
  var code = readFileSync(resolvedpath, "utf8");
  var script = createScript(code, "conf");
  var scope = self._scope;
  var sandbox = {};

  SANDBOX_PROPS.forEach(function(prop) {
    for (var name in self[prop]) {
      sandbox[name] = self[prop][name];
    }
  });

  clearResult(scope);
  
  pushScopeStack(self, scope);
  
  scope.workdir = dirname(resolvedpath);
  
  script.runInNewContext(sandbox);
  
  popScopeStack(self);
  
  applyDefaults(scope);
  validateRequired(scope);
  
  return scope.result;
}

/**
 *  ### ConfigContext.applyMarkup()
 */
ConfigContext.prototype.applyMarkup = function(markup)  {
  var scope = this._scope;
  updateSection(this, scope, markup);
}

function updateSection(self, scope, markup) {
  var struct;
  var field;
  var subscope;
  
  for (var name in markup) {
    
    if (scope.fields[name]) {
      throw new Error("conf: Property is already defined '" + name + "'");
    }

    struct = getPropertyStruct(name, markup[name]);
    
    if (struct.defaultValue !== NIL) {
      scope.defaultValues[name] = struct.defaultValue;
    }

    if (struct.required) {
      scope.requiredValues[name] = true;
    }

    if (struct.multi && !struct.required && struct.defaultValue === NIL) {
      scope.defaultValues[name] = [];
    }

    if (struct.type === Section) {
      subscope = { root: scope.root
                 , parent: scope
                 , fields: {}
                 , result: {}
                 , defaultValues: {}
                 , requiredValues: {} 
                 , stack: [] };
                 
      struct.scope = subscope;           
      
      updateSection(self, subscope, struct.markup);
      
      if (!self._sectionProps[name]) {
        
        if (self._fieldProps[name]) {
          throw new Error("Cannot define a section with same name as a field");
        }
        
        self._sectionProps[name] = createSectionProp(self, name);
      }
              
    } else {

      if (!self._fieldProps[name]) {

        if (self._sectionProps[name]) {
          throw new Error("Cannot define a field with same name as a section");
        }

        self._fieldProps[name] = createFieldProp(self, name);
      }
    }
    
    scope.fields[name] = struct;
  }
}

function createSectionProp(self, name) {
  return function() {
    var args = slice.call(arguments);
    
    args.forEach(function(arg) {
      var index = self._currentScope.stack.indexOf(arg);
      self._currentScope.stack.splice(index);
    })

    function stackCallback(inscope) {
      var scope = inscope || self._currentScope;
      var struct = scope.fields[name];
      var context;
      var struct;
      var setter;
      var section;

      if (!struct) {
        throw new Error("conf: Property '" + name + "' cannot be defined in..");
      }

      context = { name: name
                , self: self
                , scope: scope
                , struct: struct
                , args: args };

      sectionScope = struct.scope;
      sectionScope.stack = args;

      if (struct.acceptArgs) {

        for (var i = 0; i < args.length; i++) {
          sectionScope.result[i.toString()] = groupArgs[i];
        }

        return function() {
          context.args = slice.call(arguments);

          clearResult(sectionScope);

          sectionSetter.call(context);
        };
      } else {
        clearResult(sectionScope);
        sectionSetter.call(context);
      }
    }
    
    self._currentScope.stack.push(stackCallback);
    
    return stackCallback;
  }
}

function createFieldProp(self, name) {
  return function() {
    var args = slice.call(arguments);
    
    function stackCallback(inscope) {
      var scope = inscope || self._currentScope;
      var struct;
      var context;
      
      if (!scope || !scope.fields || !(struct = scope.fields[name])) {
        throw new Error("conf: Property '" + name + "' cannot be defined in..");
      }

      context = { name: name
                , self: self
                , scope: scope
                , struct: struct
                , args: args };

      fieldSetter.call(context);
    }
    
    self._currentScope.stack.push(stackCallback);
    
    return stackCallback;
  }
}


function sectionSetter() {
  var name = this.name;
  var scope = this.scope;
  var struct = this.struct;
  var sectionScope = this.struct.scope;
  var stack = sectionScope.stack;
    
  stack.forEach(function(callback) {
    callback(sectionScope);
  });

  applyDefaults(sectionScope);
  validateRequired(sectionScope);
  
  if (struct.multi) {
    
    if (!(name in scope.result)) {
      scope.result[name] = [];
    }
    
    scope.result[name].push(sectionScope.result);
  } else {
    scope.result[name] = sectionScope.result;
  }
}

// Generate a sandbox function for specified property type.
function fieldSetter() {
  var name = this.name;
  var scope = this.scope;
  var args = this.args;
  var struct = this.struct;
  
  if (args.length == 0) {
    return scope.result[name];
  }
  console.log("is multi: " + struct.multi + " " + name)
  if (struct.multi) {

    if (!(name in scope.result)) {
      scope.result[name] = [];
    }

    args.forEach(function(value) {
      scope.result[name].push(validateValue(name, value, struct, scope.root));
    });
    
  } else if (args.length > 1) {
    throw new Error("conf[" + name + "]: Expected one value only");
  } else {
    scope.result[name] = validateValue(name, args[0], struct, scope.root);
  }

  return scope.result[name];
}

function pushScopeStack(self, scope) {
  if (self._currentScope) {
    self._scopeStack.push(self._currentScope);
  }
  
  return self._currentScope = scope;
}

function popScopeStack(self) {
  var currentScope = self._currentScope;
  var stack = currentScope.stack;

  stack.forEach(function(callback) {
    callback(currentScope);
  });
  
  return self._currentScope = self._scopeStack.pop();
}

function clearResult(scope) {
  for (var prop in scope.result) {
    delete scope.result[prop];
  }
}

function applyDefaults(scope) {
  for (var field in scope.defaultValues) {
    if (!(field in scope.result)) {
      scope.result[field] = scope.defaultValues[field];
    }
  }
}

function validateRequired(scope) {
  for (var field in scope.requiredValues) {
    if (!(field in scope.result)) {
      throw new Error("conf: Required property '" + field + "' was not set.");
    }
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
           , multi: false
           , required: false
           , defaultValue: NIL};
  } else if (expr === Number) {
    return { type: Number
           , multi: false
           , required: false
           , defaultValue: NIL};
  } else if (expr === Array) {
    return { type: Array
           , multi: false
           , required: false
           , defaultValue: NIL};
  } else if (expr === Object) {
    return { type: Object
           , multi: false
           , required: false
           , defaultValue: NIL};
  } else if (ctor === RegExp) {
    return { type: RegExp
           , multi: false
           , required: false
           , expr: expr
           , defaultValue: NIL};
  } else if (expr === "path") {
    return { type: Path
           , multi: false
           , required: false
           , defaultValue: NIL};
   } else if (expr === "PATH") {
     return { type: Path
            , multi: false
            , required: true
            , defaultValue: NIL};
   } else if (expr === "string") {
     return { type: String
            , multi: false
            , required: false
            , defaultValue: NIL};
  } else if (expr === "STRING") {
     return { type: String
            , multi: false
            , required: true
            , defaultValue: NIL};
  } else if (expr === "number") {
     return { type: Number
            , multi: false
            , required: false
            , defaultValue: NIL};
  } else if (expr === "NUMBER") {
     return { type: Number
            , multi: false
            , required: true
            , defaultValue: NIL};
  } else if (Array.isArray(expr) && expr.length == 1 && expr[0] == String) {
    return { type: String
           , multi: true
           , required: false
           , defaultValue: NIL};
  } else if (Array.isArray(expr) && expr.length == 1 && expr[0] == Number) {
    return {type: Number
           , multi: true
           , required: false
           , defaultValue: NIL};
  } else if (Array.isArray(expr) && expr.length == 1 && expr[0] == Array) {
    return { type: Array
           , multi: true
           , required: false
           , defaultValue: NIL};
  } else if (Array.isArray(expr) && expr.length == 1 && expr[0] == Object) {
    return { type: Object
           , multi: true
           , required: false
           , defaultValue: NIL};

  } else if (Array.isArray(expr) && expr.length == 1 && ctor === RegExp) {
    return { type: RegExp
           , multi: true
           , required: false
           , defaultValue: NIL};

  } else if (Array.isArray(expr) && expr.length == 1 && expr[0] === "path") {
    return { type: Path
           , multi: true
           , required: false
           , defaultValue: NIL};
  } else {
    if (expr.section) {
      return { type: Section
             , multi: expr.multi || false
             , required: expr.required || false
             , markup: expr.section
             , defaultValue: "defaultValue" in expr ? expr.defaultValue : NIL};
    } else if (expr.type && expr.type.constructor === RegExp) {
      return { type: RegExp
             , multi: expr.multi || false
             , required: expr.required || false
             , expr: expr.expr
             , defaultValue: "defaultValue" in expr ? expr.defaultValue : NIL};
    } else if (expr.type && expr.type === "path") {
      return { type: Path
             , multi: expr.multi || false
             , required: expr.required || false
             , defaultValue: "defaultValue" in expr ? expr.defaultValue : NIL};
    } else if (expr.type && expr.type === "PATH") {
      return { type: Path
             , multi: expr.multi || false
             , required: expr.required || true
             , defaultValue: "defaultValue" in expr ? expr.defaultValue : NIL};
    } else if (expr.type && expr.type === "string") {
      return { type: String
             , multi: expr.multi || false
             , required: expr.required || false
             , defaultValue: "defaultValue" in expr ? expr.defaultValue : NIL};
    } else if (expr.type && expr.type === "STRING") {
      return { type: String
             , multi: expr.multi || false
             , required: expr.required || true
             , defaultValue: "defaultValue" in expr ? expr.defaultValue : NIL};
    } else if (expr.type && expr.type === "number") {
      return { type: Number
             , multi: expr.multi || false
             , required: expr.required || false
             , defaultValue: "defaultValue" in expr ? expr.defaultValue : NIL};
    } else if (expr.type && expr.type === "NUMBER") {
      return { type: Number
             , multi: expr.multi || false
            , required: expr.required || true
            , defaultValue: "defaultValue" in expr ? expr.defaultValue : NIL};
    } else if (!expr.type) {
      throw new Error("Expected 'type'");
    } else {
      return expr;
    }
  }
}

function validateValue(name, value, struct, scope) {
  var strict = scope.strict;
  var workdir = scope.workdir;

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
