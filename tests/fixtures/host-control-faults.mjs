// Preload into an owned test Host only. Public HTTP Server hooks inject faults
// without adding production debug routes or relying on inspector/private APIs.
import { Server } from "node:http";

const listen = Server.prototype.listen;
const close = Server.prototype.close;
const exit = process.exit;
let target;
let failDrain = false;
let stallExit = false;

Server.prototype.listen = function (...args) {
  this.once("listening", () => {
    if (this.address()?.port === Number(process.env.INSPIRE_PORT))
      target = this;
  });
  return Reflect.apply(listen, this, args);
};

Server.prototype.close = function (callback) {
  if (this === target && failDrain) {
    return Reflect.apply(close, this, [
      (error) => callback?.(error ?? new Error("fixture HTTP drain failure")),
    ]);
  }
  return Reflect.apply(close, this, [callback]);
};

process.exit = function (code) {
  if (stallExit) {
    process.stdout.write("fixture-exit-stalled\n");
    return;
  }
  return Reflect.apply(exit, process, [code]);
};

let commands = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  commands += chunk;
  for (;;) {
    const end = commands.indexOf("\n");
    if (end < 0) return;
    const command = commands.slice(0, end);
    commands = commands.slice(end + 1);
    if (command === "drop-http") {
      target.close(() => process.stdout.write("fixture-http-dropped\n"));
    } else if (command === "fail-drain") {
      failDrain = true;
      process.stdout.write("fixture-drain-armed\n");
    } else if (command === "stall-exit") {
      stallExit = true;
      process.stdout.write("fixture-exit-armed\n");
    } else {
      throw new Error("Unknown Host fault fixture command");
    }
  }
});
