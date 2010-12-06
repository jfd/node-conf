var createContext = require("../../lib/conf").createContext;
var createScript = require("../../lib/conf").createScript;


var context = createContext({
  
  server_name: {type: String, value: "test"},
  
  zone: Number,
  
  debug: Boolean,
  
  simple: { property: "name", struct: {
    name: { type: String },
    field: { type: "static", value: "test"}
  }},
  
  server: { index: "_index", section: {
    serverType: { type: "static", value: "http"},
    path: "path",
    location: { list: true, section: {
      allow: String,
      deny: ["path"]
    }}
  }},
  
  proxy: { property: "type", section: {
    type: String,
    name: String
  }}
  
});

script = createScript("./example.conf");

config = script.runInContext(context, {DEBUG: true });

console.log(config);
