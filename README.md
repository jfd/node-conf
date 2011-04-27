
# Conf

Conf is a general purpose configuration platform for Nodejs. It can be used to create simple config files or even more advance user scripts. 

The config scripts are plain old javascript with a definition layer on top of
it.


Here is an example:

    server
        hostname  = "127.0.0.1"
        port      = 80

        location = "/articles"
            root = "/var/www/sites/my_site/articles"
            expires = "30d"
        end

        location = "/home"
            redirect = "/"
        end
    end

The above example would result in the following JavaScript graph 
when parsed:

    { 
      server: { hostname: "127.0.0.1"
              , port: 80
              , location: [
                  { url: "/articles"
                  , root: "/var/www/sites/my_site/articles"
                  , exipres: "30d"
                  },
                  { url: "/home"
                  , redirect: "/"
                  }
                ]
              }
    }

As mention above, the config scripts is Javascript, so it is possible to mix
your DSL with Javascript. This is a powerful feature, which let you do 
stuff like this:

    LOCATIONS = ["/articles", "/comments", "/users"]

    server
        hostname  = "127.0.0.1"
        port      = 80

        LOCATIONS.forEach(function(path) {
          location = path
              root = "/var/www/sites/my_site" + path
              expires = "30d"
          end
        });

        location = "/home"
            redirect = "/"
        end
    end


# API

The API is defined by two functions: `createContext` and `createScript`. The
`createContext` creates a markup that can be used with `createScript`.

### createContext(markup)

Construct a new config context object. The config context is then used
to run a config script.

The `markup` is a data graph, that is used to describe the config script
layout. A simple example:

    var conf = require("conf");
    conf.createContext({
      host: { type: "string", value: "localhost" },
      port: { type: "number", value: 8080}
    });


The first key, `host`, represents a String property with default 
value `"localhost"`. The second key, `port`, represents a Number property
with default value `8080`.

A valid config script for example context above would look
look like:

    host = "10.0.0.1"
    port = 80


See the "Defining context markup" -section for complete documentation.


### createScript(path, [filename])

Construct a new config script object, from specified path. An optional
`filename` can be set

This function is synchronous and throws an exception on read errors.


## Script

Represents a Script.



### Script.runInContext(context, [env])


## RuntimeError

All errors produced by "conf" is derived from the class RuntimeError. The
RunTimeError class inherits the native Error class.

### RuntimeError.getSimpleMessage

Returns a simplified message, without stack trace information, but with 
error message and line number. 

The `getSimpleMessage` method is useful when you want to show user what's
wrong, without showing what happen "behind-the-scene".


## Defining context markup 

There is 15 different types of fields, each with it's own set of
properties. 

Many of the types share's a set of properties. For example, `required` can
be used with any type. The common properties are:

- `required` set to `true` to indicate that the field is required.
- `list` indicates that there can be multiply definitions of the field.
- `strict` indicates that the field value should be validated strictly.
- `value` sets a default value for the field.
- `idxignore` indicates that the field should be ignored in an index.
- `param` has different meaning in different types. See type documentation for implementation.
- `index` use field in a index.
- `onenter` callback when entering a section (see section documentation for more details).
- `onexit` callback when exiting a section (see section documentation for more details).

Some of the types can be used with a "shortcut". Shortcuts is used to 
quickly define a property, without adding additionally markup. Here is an
example of a shortcut in action:

    conf.createContext({
      host: String
    });

The above example is mapped to:

    conf.createContext({
      host: { type: "string" }
    }); 

It is also possible to map the type with it's name:

    conf.createContext({
      host: "string"
    });

A required field can be defined by typing the type name with capitals:

    conf.createContext({
      host: "STRING"
    });

Which maps to:

    conf.createContext({
      host: { type: "string", required: true }
    });

It is also possible to define a list with shortcut. Just encapsulate with
brackets as follows: 

    conf.createContext({
      host: ["string"]
    });

---

The different types of fields are: `boolean`, `string`, `number`, `array`,
`object`, `regexp`, `expression`, `path`, `static`, `wildcard` `section`,
`struct`, `custom`, `bytesize` and `timeunit`.

### boolean

Represents a boolean value. Valid values in strict mode are 
`true` or `false`. Undefined values is converted to `true` in non-strict
mode.

The native class `Boolean` works as a shortcut for the boolean field type.

### string

Represents a String value. Values, which is not of native type string, are 
converted to a string object via the `toString` method in non-strict mode.

The native class `String` works as a shortcut for the string field type.

### number

Represents a Number value. Values, which is not of native type number, are 
converted to numbers via the `parseInt` function in non-strict mode.

The native class `Number` works as a shortcut for the string field type.

### array

Represents an Array value. Values, which is not of native type array, are
encapsulated with bracets in non-strict mode.

The native class `Array` works as a shortcut for the string field type.

### object

Represents an Object value. All values, except `undefined` and `null`, are
accepted.

The native class `Object` works as a shortcut for the string field type.

### regexp

Represents a RegExp value. String values is converted into RegExp instances
via it's constructor in non-strict mode.

The native class `RegExp` works as a shortcut for the string field type.

### expression

Represents a string value, that is validated against a RegExp expression.

The field property ´param` MUST contain an RegExp instance.

An expression example:

    createContext({
      method: { type: "expression", param: /^(get|set)$/ }
    });

A more convenience may be to use expression types shortcut:

    createContext({
      method: { type: /^(get|set)$/ }
    });

Or, the even more convenience shortcut:

    createContext({
      method: /^(get|set)$/
    });

### path

Represents a file-system path value, with relative-path support. Values, 
which is not of native type String, are converted to a string object via 
the `toString` method in non-strict mode.

Relative path's is mapped against scripts `workdir` variable.

Example (markup):

    createContext({
      data_file: { type: "path" }
    });

Example (config):

    data_file = "./data/data.json"

Result for example above:

    { data_file: "/parent_directory_of_config_file/data/data.json" }
      
This field is currently not supported on Windows.

### static

Represents a static value. Static values cannot be set, they behave more
like traditional `constants`, except that they cannot be accessed in
the config file, just the result.

The field property `value` **must** be set for static fields.

Example:

    createContext({
      debug: { type: "static", value: true }
    });

Which results in:

    { debug: true }
    
### wildcard

Wildcards can contain any kind of value.
    

### section

Represents a section. Sections is used to divide fields into groups.

Section's has a set of special properties that can be set:

- `property` sets a default field for the section.
- `index` creates an index for the section, with specified name. This is
  useful when the order of section fields is needed.
- `section` is the shortcut for sections.

See use-cases in examples below.

The section scope MUST be closed with the built-in keyword `end` (see 
section "Built-in keywords" for more details) when defining it in a
config file.

The field property `param` MUST be set for static fields.

A quick example:

    createContext({
      database: { type: "section", param: {
        port: Number,
        host: String
      }}
    });

    ---

    database
      port = 8080
      host = "127.0.0.1"
    end

Which results in:

    { database: { 
      port: 8080, 
      host: "127.0.0.1"
    }}

One more convenient way would be to use the `section` shortcut. Here is
an example that represents the markup above:

    createContext({
      database: { section: {
        port: Number,
        host: String
      }}
    });

There is no need for the `param` property when defining sections with the
shortcut.

### struct

Represents a struct. Struct is similar to section's but cannot only
contain one child field. The struct is also laking some of the 
special properties that section supports. 

The special property `property` is supported though. 

Note: The `end` keyword is NOT supported in struct fields.

    createContext({
      static_server: { type: "struct", param: {
        port: { type: "static", value: 8080},
        host: { type: "static", value: "127.0.0.1"}
      }}
    });

### custom

Represents a custom value. Custom values are validated with provided 
function. 

Example:

    function customValue(field, value, runtime) {
      
      if (value !== "value") {
        throw new Error("Expected value");
      }
      
      return value;
    }
    
    createContext({
      my_custom: { type: "custom", param: customValue };
    });
    
Custom values also have a shortcut. Just put the validator as type:

    createContext({
      my_custom: { type: customValue };
    });


### bytesize

Represents a byte size value. Byte size values is defined by a number or
a string expression.

The string expression is defined with a number and a suffix. Supported
suffixes are:

- `b` represents a byte.
- `kb` represents a kilobyte (1024 bytes)
- `mb` represents a megabyte (1024 * 1024 bytes)
- `gb` represents a gigabyte (1024 * 1024 * 1024 bytes)

Here is an example with a string expression.

    createContext({
      max_file_size: { type: "bytesize" };
    });
    
    ---
    
    max_file_size = "12mb"
    

### timeunit

Represents a time unit value. Time unit values is defined by a number or
a string expression.

The string expression is defined with a number and a suffix. Supported
suffixes are:

- `ms` represents a millisecond.
- `s` represents a second (1000 milliseconds)
- `m` represents a minute (60 * 1000 milliseconds)
- `h` represents an hour (60 * 60 * 1000 milliseconds)
- `d` represents a day (24 * 60 * 60 * 1000 milliseconds)

Here is an example with a string expression.

    createContext({
      backup_interval: { type: "timeunit" };
    });
    
    ---
    
    backup_interval = "1h"
    
The return value is always in milliseconds.

## Built-in keywords

There is two built-in config file keywords, `end` and `include`. The
keyword `end` is called as a property while the `include` is called as
a function.

### end

The keyword `end` is used to close a scope (section). The script-engine
is automatically closing scopes on end of execution, but it's good to
always call `end` anyway.

    section
        field = "field value" 
    end

### include(path)

The keyword `include` imports another config script and executes it in
current runtime. The `path` argument must be set and should point
to the script to include. Relative-paths are accepted.

    include("./mime_types.conf")

It is also possible to use wildcard patterns to include one ore more
files. Supported special characters are **"*"** and **"?"**. 

    include("./sites/*.conf");

Note: The `include` keyword does not check if config is already included. This could result in a never-ending loop if a config includes it self.

## License

BSD-License.

Copyright (c) Johan Dahlberg 2011
