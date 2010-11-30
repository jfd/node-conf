var createContext = require("../lib/conf").createContext;


var context = createContext({
  
  // server_name: String
  
  server_name: {type: String, defaultValue: "test"},
  
  server: { section: {
    location: { section: {
      allow: String,
      deny: ["path"]
    }}
  }}
  
});

context.define("DEBUG");


config = context.parse("./example.conf");

console.log(config);
