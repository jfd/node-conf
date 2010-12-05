var createContext = require("../../lib/conf").createContext;
var createScript = require("../../lib/conf").createScript;


var context = createContext({
  
  server_name: {type: String, value: "test"},
  
  zone: Number,
  
  debug: Boolean,
  
  server: { section: {
    path: "path",
    location: { list: true, section: {
      allow: String,
      deny: ["path"]
    }}
  }},
  
  proxy: { index: "type", section: {
    type: String,
    name: String
  }}
  
});

script = createScript("./example.conf");

config = script.runInContext(context, {DEBUG: true });

console.log(config);
