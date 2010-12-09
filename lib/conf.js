/**
 *  ## Node-conf
 *
 *  Using JSON for configuration is great many times. But sometimes, you need
 *  to do more that just placing markup in a text file.
 *
 *  Node-conf tries to solve this by combinding an easy-to-read data design 
 *  pattern, with good old javascript.
 *
 *  Here is a example of how a config file may look like:
 *
 *      server
 *          hostname  = "127.0.0.1"
 *          port      = 80
 *
 *          location = "/articles"
 *              root = "/var/www/sites/my_site/articles"
 *              expires = "30d"
 *          end
 *
 *          location = "/home"
 *              redirect = "/"
 *          end
 *      end
 *
 *  The above example would result in the following JavaScript graph 
 *  wheb parsing the config script:
 *
 *      { 
 *        server: { hostname: "127.0.0.1"
 *                , port: 80
 *                , location: [
 *                    { url: "/articles"
 *                    , root: "/var/www/sites/my_site/articles"
 *                    , exipres: "30d"
 *                    },
 *                    { url: "/home"
 *                    , redirect: "/"
 *                    }
 *                  ]
 *                }
 *      }
 *
 *  The design is inspired by Ngnix's config format. For a full configuration 
 *  example, please see nginx-example in "examples/nginx".
 */
const createScript          = require("vm").createScript
    , readFileSync          = require("fs").readFileSync
    , normalize             = require("path").normalize
    , dirname               = require("path").dirname
    , basename              = require("path").basename;

const slice                 = Array.prototype.slice;

const NIL                   = {};

const WRAPPER_TMPL          = "with (__props) {%s;\n}";

const REQUIRED_RE           = /^[A-Z]*$/
    , RESERVED_NAMES_RE     = /^(end|include)$/
    , PARAM_REQUIRED_RE     = /^(struct|section|expression|custom)/;

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
 *        host: { type: "string", value: "localhost" },
 *        port: { type: "number", value: 8080}
 *      });
 *
 *
 *  The first key, `host`, represents a String property with default 
 *  value `"localhost"`. The second key, `port`, represents a Number property
 *  with default value `8080`.
 *
 *  A valid config script for example context above would look
 *  look like:
 *
 *      host = "10.0.0.1"
 *      port = 80
 *
 *
 *  See the "Defining context markup" -section for complete documentation.
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
 *  ### conf.createScript(path, [filename])
 *
 *  Construct a new config script object, from specified path. An optional
 *  `filename` can be set
 *
 *  This function is synchronous and throws an exception on read errors.
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
  this.name = "[ROOT]";
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
    if (RESERVED_NAMES_RE(name)) {
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
    
    if (RESERVED_NAMES_RE(name)) {
      throw new Error("conf: '" + name + "' is reserved.");
    }
    
    if (scope._fields[name] || scope._statics[name]) {
      throw new Error("conf: Property is already defined '" + name + "'");
    }

    field = getPropertyField(name, markup[name]);
    
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
    
    if (PARAM_REQUIRED_RE(field.type) && !field.param) {
      throw new Error("conf: `param`must be set for field.");
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

    if (field.type === "section" || field.type == "struct") {
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

        applyResult.call(this, prop, value);
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
  var result = this._currentResult;
  var index = !field.idxignore && this._currentIndex;
  var validated;

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

  } else if (name in result) {
    throw new Error("conf[" + name + "]: Expected one value only");
  } else {
    validated = validateValue.call(this, field, value);
    result[name] = validated
    index && (index[index.length] = validated);
  }

  return validated;
}


// End scope
function endScope(scope, result, index) {
  var keys;
  var key;
  var length;
  var field;
  
  keys = Object.keys(scope._fields);
  length = keys.length;
  
  while (length--) {
    key = keys[length];
    field = scope._fields[key];

    if (!(key in result)) {
      if (scope._defaults[key]) {
        if (field.list) {
          result[key] = []  ;
          if (Array.isArray(scope._defaults[key])) {
            scope._defaults[key].forEach(function(val) {
              result[key].push(scope._defaults[key]);
              index && (index[index.length] = scope._defaults[key]);
            });
          } else {
            result[key].push(scope._defaults[key]);
          }
        } else {
          result[key] = scope._defaults[key];
        }
      } else if (field.list && !field.required) {
        result[key] = [];
      }
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
    applyResult.call(this, scope, result);
  }
}


// Get a struct from expression
function getPropertyField(name, expr) {
  var type = null;
  var required = false;
  var list = false;
  var value = NIL;
  var param = null;
  var index = null;
  var property = null;
  var strict = false;
  var idxignore = false;
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
    required = REQUIRED_RE(expr) && true || false;
  } else if ((i = NATIVE_TYPE_MAPPING.indexOf(expr)) != -1) {
    type = NATIVE_TYPE_MAPPING[i + 1];
  } else if (typeof expr == "function") {
    type = "custom";
    param = expr;
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
    } else if (expr.type && typeof expr.type == "function") {
      type = "custom";
      param = expr.type;
    }
    required = expr.required || (REQUIRED_RE(expr) && true || false);
    value = "value" in expr && expr.value || NIL; 
    list = expr.list || false;
    param = param && param || expr.param;
    index = index && index || expr.index;
    strict = expr.strict || false;
    idxignore = expr.idxignore || false;
  }
  
  if (PROPERTY_TYPES.indexOf(type) == -1) {
    throw new Error("conf: Unknown field type: " + type);
  }

  return {
    name: name,
    type: type,
    property: property,
    list: list,
    required: required,
    param: param,
    strict: strict,
    value: value,
    idxignore: idxignore,
    _index: index
  }
}

// Validate value against struct
function validateValue(field, value) {
  var name = this.name;
  var strict = this.strict || field.strict;
  var workdir = this.workdir;

  switch (field.type) {

    case "wildcard":
      return value;
      
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
      
    case "custom":
      return field.param(field, value, this);
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
 *  ## Defining context markup 
 *
 *  There is 13 different types of fields, each with it's own set of
 *  properties. 
 *
 *  Many of the types share's a set of properties. For example, `required` can
 *  be used with any type. The common properties are:
 *
 *  - `required` set to `true` to indicate that the field is required.
 *  - `list` indicates that there can be multiply definitions of the field.
 *  - `strict` indicates that the field value should be validated strictly.
 *  - `value` sets a default value for the field.
 *  - `idxignore` indicates that the field should be ignored in an index.
 *
 *  Some of the types can be used with a "shortcut". Shortcuts is used to 
 *  quickly define a property, without adding additionally markup. Here is an
 *  example of a shortcut in action:
 *
 *      conf.createContext({
 *        host: String
 *      });
 *
 *  The above example is mapped to:
 *
 *      conf.createContext({
 *        host: { type: "string" }
 *      }); 
 *
 *  It is also possible to map the type with it's name:
 *
 *      conf.createContext({
 *        host: "string"
 *      });
 *
 *  A required field can be defined by typing the type name with capitals:
 *
 *      conf.createContext({
 *        host: "STRING"
 *      });
 *
 *  Which maps to:
 *
 *      conf.createContext({
 *        host: { type: "string", required: true }
 *      });
 *
 *  It is also possible to define a list with shortcut. Just encapsulate with
 *  bracets as follows: 
 *
 *      conf.createContext({
 *        host: ["string"]
 *      });
 *
 *  ---
 *
 *  The different types of fields are: `boolean`, `string`, `number`, `array`,
 *  `object`, `regexp`, `expression`, `path`, `static`, `wildcard` `section`,
 *  `struct` and `custom`.
 *
 *  ### boolean
 *
 *  Represents a boolean value. Valid values in strict mode are 
 *  `true` or `false`. Undefined values is converted to `true` in non-strict
 *  mode.
 *
 *  The native class `Boolean` works as a shortcut for the boolean field type.
 *
 *  ### string
 *
 *  Represents a String value. Values, which is not of native type string, are 
 *  converted to a string object via the `toString` method in non-strict mode.
 *
 *  The native class `String` works as a shortcut for the string field type.
 *
 *  ### number
 *
 *  Represents a Number value. Values, which is not of native type number, are 
 *  converted to numbers via the `parseInt` function in non-strict mode.
 *
 *  The native class `Number` works as a shortcut for the string field type.
 *
 *  ### array
 *
 *  Represents an Array value. Values, which is not of native type array, are
 *  encapsulated with bracets in non-strict mode.
 *
 *  The native class `Array` works as a shortcut for the string field type.
 *
 *  ### object
 *
 *  Represents an Object value. All values, except `undefined` and `null`, are
 *  accepted.
 *
 *  The native class `Object` works as a shortcut for the string field type.
 *
 *  ### regexp
 *
 *  Represents a RegExp value. String values is converted into RegExp instances
 *  via it's constructor in non-strict mode.
 *
 *  The native class `RegExp` works as a shortcut for the string field type.
 *
 *  ### expression
 *
 *  Represents a string value, that is validated against a RegExp expression.
 *
 *  The field property ´param` MUST contain an RegExp instance.
 *
 *  An expression example:
 *
 *      createContext({
 *        method: { type: "expression", param: /^(get|set)$/ }
 *      });
 *
 *  A more convenience may be to use expression types shortcut:
 *
 *      createContext({
 *        method: { type: /^(get|set)$/ }
 *      });
 *
 *  Or, the even more convenience shortcut:
 *
 *      createContext({
 *        method: /^(get|set)$/
 *      });
 *
 *  ### path
 *
 *  Represents a file-system path value, with relative-path support. Values, 
 *  which is not of native type String, are converted to a string object via 
 *  the `toString` method in non-strict mode.
 *
 *  Relative path's is mapped against scripts `workdir` variable.
 *
 *  Example (markup):
 *
 *      createContext({
 *        data_file: { type: "path" }
 *      });
 *
 *  Example (config):
 *
 *      data_file = "./data/data.json"
 *
 *  Result for example above:
 *
 *      { data_file: "/parent_directory_of_config_file/data/data.json" }
 *        
 *  This field is currently not supported on Windows.
 *
 *  ### static
 *
 *  Represents a static value. Static values cannot be set, they behave more
 *  like traditional `constants`, except that they cannot be accesed in
 *  the config file, just the result.
 *
 *  The field property `value` MUST be set for static fields.
 *
 *  Example:
 *
 *      createContext({
 *        debug: { type: "static", value: true }
 *      });
 *
 *  Which results in:
 *
 *      { debug: true }
 *
 *  ### section
 *
 *  Represents a section. Sections is used to divide fields into groups.
 *
 *  Section's has a set of special properties that can be set:
 *
 *  - `property` sets a default field for the section.
 *  - `index` creates an index for the section, with specified name. This is
 *    useful when the order of section fields is needed.
 *  - `section` is the shortcut for sections.
 *
 *  See use-cases in examples below.
 *
 *  The section scope MUST be closed with the built-in keyword `end` (see 
 *  section "Built-in keywords" for more details) when defining it in a
 *  config file.
 *
 *  The field property `param` MUST be set for static fields.
 *
 *  A quick example:
 *
 *      createContext({
 *        database: { type: "section", param: {
 *          port: Number,
 *          host: String
 *        }}
 *      });
 *
 *      ---
 *
 *      database
 *        port = 8080
 *        host = "127.0.0.1"
 *      end
 *
 *  Which results in:
 *
 *      { database: { 
 *        port: 8080, 
 *        host: "127.0.0.1"
 *      }}
 *
 *  One more convenient way would be to use the `section` shortcut. Here is
 *  an example that represents the markup above:
 *
 *      createContext({
 *        database: { section: {
 *          port: Number,
 *          host: String
 *        }}
 *      });
 *
 *  There is no need for the `param` property when defining sections with the
 *  shortcut.
 *
 *  ### struct
 *
 *  Represents a struct. Struct is similar to section's but cannot only
 *  contain one child field. The struct is also laking some of the 
 *  special properties that section supports. 
 *
 *  The special property `property` is supported though. 
 *
 *  Note: The `end` keyword is NOT supported in struct fields.
 *
 *      createContext({
 *        static_server: { type: "struct", param: {
 *          port: { type: "static", value: 8080},
 *          host: { type: "static", value: "127.0.0.1"}
 *        }}
 *      });
 *
 *  ### custom
 *
 *  Represents a custom value. 
 */

/**
 *  ## Built-in keywords
 *
 *  There is two built-in config file keywords, `end` and `include`. The
 *  keyword `end` is called as a property while the `include` is called as
 *  a function.
 *
 *  ### end
 *  
 *  The keyword `end` is used to close a scope (section). The script-engine
 *  is automatically closing scopes on end of execution, but it's good to
 *  always call `end` anyway.
 *
 *      section
 *          field = "field value" 
 *      end
 *
 *  ### include(path)
 *
 *  The keyword `include` imports another config script and executes it at
 *  current runtime position. The `path` argument must be set and should point
 *  to the script to include. Relative-paths are accepted.
 *
 *      include("./mime_types.conf")
 *
 */

/**
 *  ## License
 *
 *  BSD-License.
 *
 *  Copyright (c) Johan Dahlberg 2010 
 */