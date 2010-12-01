var createContext = require("../lib/conf").createContext;
var createScript = require("../lib/conf").createScript;


var context = createContext({
  
  // server_name: String
  
  server_name: {type: String, value: "test"},
  
  zone: Number,
  
  server: { section: {
    path: "path",
    location: { section: {
      allow: String,
      deny: ["path"]
    }}
  }},
  
  proxy: { index: "type", section: {
    type: String,
    name: String
  }}
  
});

context.define("DEBUG");


// config = context.parse("./example.conf");

script = createScript("./example.conf");

config = script.runInContext(context);

console.log(config);
