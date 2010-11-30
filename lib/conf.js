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

const PROP_TMPL = "\n\
Object.defineProperty(__context__, '%s', {\
  get: __props__['%s'],set: __props__['%s']\
});";


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
}

ConfigScript.prototype.runInContext = function(context) {
  var sandbox = { __props__ : {} };
  var wrapper = [];
  var sections;
  var keywords;
  var fields;
  var script;
  var scope;
  
  if (!context || !context instanceof ConfigContext) {
    throw new Error("Expected a ConfigContext");
  }

  fields = context._fieldProps;
  sections = context._sectionProps;

  wrapper[wrapper.length] = "var __context__ = {};";
  
  for (var name in fields) {
    sandbox["__props__"][name] = fields[name];
    wrapper[wrapper.length] = PROP_TMPL.replace(/\%s/g, name);
  }
  
  for (var name in sections) {
    sandbox["__props__"][name] = sections[name];
    wrapper[wrapper.length] = PROP_TMPL.replace(/\%s/g, name);
  }
  
  sandbox.__props__.end = function() {
    popScopeStack(context);
  }
  
  wrapper[wrapper.length] = PROP_TMPL.replace(/\%s/g, "end");
  
  wrapper[wrapper.length] = "with (__context__) {\n" + this.code + "\n}";

  script = createScript(wrapper.join("\n"), this.filename);

  scope = context._scope;
  
  pushScopeStack(context, scope);
  
  // scope.workdir = dirname(resolvedpath);
  
  script.runInNewContext(sandbox);
  
  while (popScopeStack(context));
  
  return scope.result;
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
              , workdir: null
              , struct: null };

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
      subscope = { name: name
                 , root: scope.root
                 , parent: scope
                 , fields: {}
                 , result: {}
                 , defaultValues: {}
                 , requiredValues: {} 
                 , stack: []
                 , struct: struct };
                 
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
    var scope = self._currentScope;
    var struct = scope.fields[name];
    var struct;
    var setter;
    var section;

    if (!scope || !scope.fields || !(struct = scope.fields[name])) {
      throw new Error("conf: Property '" + name + "' cannot be defined in..");
    }
    
    pushScopeStack(self, struct.scope);
  }
}

function createFieldProp(self, name) {
  return function(value) {
    var args = Array.isArray(value) ? value : [value];
    var scope = self._currentScope;
    var struct;
    var context;
    
    if (!scope || !scope.fields || !(struct = scope.fields[name])) {
      throw new Error("conf: Property '" + name + "' cannot be defined in..");
    }

    if (args.length == 0) {
      return scope.result[name];
    }
    
    if (struct.multi) {

      if (!(name in scope.result)) {
        scope.result[name] = [];
      }

      args.forEach(function(value) {
        var validated = validateValue(name, value, struct, scope.root);
        scope.result[name].push(validated);
      });

    } else if (args.length > 1 || (name in scope.result)) {
      throw new Error("conf[" + name + "]: Expected one value only");
    } else {
      scope.result[name] = validateValue(name, args[0], struct, scope.root);
    }

    return scope.result[name];
  }
}

function pushScopeStack(self, scope) {
  if (self._currentScope) {
    self._scopeStack.push(self._currentScope);
  }
  
  return self._currentScope = scope;
}

function popScopeStack(self) {
  var currentScope = self._currentScope;
  var scope = currentScope.parent;
  var stack = currentScope.stack;
  var struct = currentScope.struct;
  var name = currentScope.name;

  applyDefaults(currentScope);
  validateRequired(currentScope);
  
  if (scope) {
    if (struct.multi) {

      if (!(name in scope.result)) {
        scope.result[name] = [];
      }

      scope.result[name].push(currentScope.result);
    } else {
      scope.result[name] = currentScope.result;
    }
  }
  
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
