#!/usr/bin/env bun
// @bun
import { createRequire } from "node:module";
var __create = Object.create;
var __getProtoOf = Object.getPrototypeOf;
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
function __accessProp(key) {
  return this[key];
}
var __toESMCache_node;
var __toESMCache_esm;
var __toESM = (mod, isNodeMode, target) => {
  var canCache = mod != null && typeof mod === "object";
  if (canCache) {
    var cache = isNodeMode ? __toESMCache_node ??= new WeakMap : __toESMCache_esm ??= new WeakMap;
    var cached = cache.get(mod);
    if (cached)
      return cached;
  }
  target = mod != null ? __create(__getProtoOf(mod)) : {};
  const to = isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target;
  for (let key of __getOwnPropNames(mod))
    if (!__hasOwnProp.call(to, key))
      __defProp(to, key, {
        get: __accessProp.bind(mod, key),
        enumerable: true
      });
  if (canCache)
    cache.set(mod, to);
  return to;
};
var __commonJS = (cb, mod) => () => (mod || cb((mod = { exports: {} }).exports, mod), mod.exports);
var __require = /* @__PURE__ */ createRequire(import.meta.url);

// node_modules/commander/lib/error.js
var require_error = __commonJS((exports) => {
  class CommanderError extends Error {
    constructor(exitCode, code, message) {
      super(message);
      Error.captureStackTrace(this, this.constructor);
      this.name = this.constructor.name;
      this.code = code;
      this.exitCode = exitCode;
      this.nestedError = undefined;
    }
  }

  class InvalidArgumentError extends CommanderError {
    constructor(message) {
      super(1, "commander.invalidArgument", message);
      Error.captureStackTrace(this, this.constructor);
      this.name = this.constructor.name;
    }
  }
  exports.CommanderError = CommanderError;
  exports.InvalidArgumentError = InvalidArgumentError;
});

// node_modules/commander/lib/argument.js
var require_argument = __commonJS((exports) => {
  var { InvalidArgumentError } = require_error();

  class Argument {
    constructor(name, description) {
      this.description = description || "";
      this.variadic = false;
      this.parseArg = undefined;
      this.defaultValue = undefined;
      this.defaultValueDescription = undefined;
      this.argChoices = undefined;
      switch (name[0]) {
        case "<":
          this.required = true;
          this._name = name.slice(1, -1);
          break;
        case "[":
          this.required = false;
          this._name = name.slice(1, -1);
          break;
        default:
          this.required = true;
          this._name = name;
          break;
      }
      if (this._name.endsWith("...")) {
        this.variadic = true;
        this._name = this._name.slice(0, -3);
      }
    }
    name() {
      return this._name;
    }
    _collectValue(value, previous) {
      if (previous === this.defaultValue || !Array.isArray(previous)) {
        return [value];
      }
      previous.push(value);
      return previous;
    }
    default(value, description) {
      this.defaultValue = value;
      this.defaultValueDescription = description;
      return this;
    }
    argParser(fn) {
      this.parseArg = fn;
      return this;
    }
    choices(values) {
      this.argChoices = values.slice();
      this.parseArg = (arg, previous) => {
        if (!this.argChoices.includes(arg)) {
          throw new InvalidArgumentError(`Allowed choices are ${this.argChoices.join(", ")}.`);
        }
        if (this.variadic) {
          return this._collectValue(arg, previous);
        }
        return arg;
      };
      return this;
    }
    argRequired() {
      this.required = true;
      return this;
    }
    argOptional() {
      this.required = false;
      return this;
    }
  }
  function humanReadableArgName(arg) {
    const nameOutput = arg.name() + (arg.variadic === true ? "..." : "");
    return arg.required ? "<" + nameOutput + ">" : "[" + nameOutput + "]";
  }
  exports.Argument = Argument;
  exports.humanReadableArgName = humanReadableArgName;
});

// node_modules/commander/lib/help.js
var require_help = __commonJS((exports) => {
  var { humanReadableArgName } = require_argument();

  class Help {
    constructor() {
      this.helpWidth = undefined;
      this.minWidthToWrap = 40;
      this.sortSubcommands = false;
      this.sortOptions = false;
      this.showGlobalOptions = false;
    }
    prepareContext(contextOptions) {
      this.helpWidth = this.helpWidth ?? contextOptions.helpWidth ?? 80;
    }
    visibleCommands(cmd) {
      const visibleCommands = cmd.commands.filter((cmd2) => !cmd2._hidden);
      const helpCommand = cmd._getHelpCommand();
      if (helpCommand && !helpCommand._hidden) {
        visibleCommands.push(helpCommand);
      }
      if (this.sortSubcommands) {
        visibleCommands.sort((a, b) => {
          return a.name().localeCompare(b.name());
        });
      }
      return visibleCommands;
    }
    compareOptions(a, b) {
      const getSortKey = (option) => {
        return option.short ? option.short.replace(/^-/, "") : option.long.replace(/^--/, "");
      };
      return getSortKey(a).localeCompare(getSortKey(b));
    }
    visibleOptions(cmd) {
      const visibleOptions = cmd.options.filter((option) => !option.hidden);
      const helpOption = cmd._getHelpOption();
      if (helpOption && !helpOption.hidden) {
        const removeShort = helpOption.short && cmd._findOption(helpOption.short);
        const removeLong = helpOption.long && cmd._findOption(helpOption.long);
        if (!removeShort && !removeLong) {
          visibleOptions.push(helpOption);
        } else if (helpOption.long && !removeLong) {
          visibleOptions.push(cmd.createOption(helpOption.long, helpOption.description));
        } else if (helpOption.short && !removeShort) {
          visibleOptions.push(cmd.createOption(helpOption.short, helpOption.description));
        }
      }
      if (this.sortOptions) {
        visibleOptions.sort(this.compareOptions);
      }
      return visibleOptions;
    }
    visibleGlobalOptions(cmd) {
      if (!this.showGlobalOptions)
        return [];
      const globalOptions = [];
      for (let ancestorCmd = cmd.parent;ancestorCmd; ancestorCmd = ancestorCmd.parent) {
        const visibleOptions = ancestorCmd.options.filter((option) => !option.hidden);
        globalOptions.push(...visibleOptions);
      }
      if (this.sortOptions) {
        globalOptions.sort(this.compareOptions);
      }
      return globalOptions;
    }
    visibleArguments(cmd) {
      if (cmd._argsDescription) {
        cmd.registeredArguments.forEach((argument) => {
          argument.description = argument.description || cmd._argsDescription[argument.name()] || "";
        });
      }
      if (cmd.registeredArguments.find((argument) => argument.description)) {
        return cmd.registeredArguments;
      }
      return [];
    }
    subcommandTerm(cmd) {
      const args = cmd.registeredArguments.map((arg) => humanReadableArgName(arg)).join(" ");
      return cmd._name + (cmd._aliases[0] ? "|" + cmd._aliases[0] : "") + (cmd.options.length ? " [options]" : "") + (args ? " " + args : "");
    }
    optionTerm(option) {
      return option.flags;
    }
    argumentTerm(argument) {
      return argument.name();
    }
    longestSubcommandTermLength(cmd, helper) {
      return helper.visibleCommands(cmd).reduce((max, command) => {
        return Math.max(max, this.displayWidth(helper.styleSubcommandTerm(helper.subcommandTerm(command))));
      }, 0);
    }
    longestOptionTermLength(cmd, helper) {
      return helper.visibleOptions(cmd).reduce((max, option) => {
        return Math.max(max, this.displayWidth(helper.styleOptionTerm(helper.optionTerm(option))));
      }, 0);
    }
    longestGlobalOptionTermLength(cmd, helper) {
      return helper.visibleGlobalOptions(cmd).reduce((max, option) => {
        return Math.max(max, this.displayWidth(helper.styleOptionTerm(helper.optionTerm(option))));
      }, 0);
    }
    longestArgumentTermLength(cmd, helper) {
      return helper.visibleArguments(cmd).reduce((max, argument) => {
        return Math.max(max, this.displayWidth(helper.styleArgumentTerm(helper.argumentTerm(argument))));
      }, 0);
    }
    commandUsage(cmd) {
      let cmdName = cmd._name;
      if (cmd._aliases[0]) {
        cmdName = cmdName + "|" + cmd._aliases[0];
      }
      let ancestorCmdNames = "";
      for (let ancestorCmd = cmd.parent;ancestorCmd; ancestorCmd = ancestorCmd.parent) {
        ancestorCmdNames = ancestorCmd.name() + " " + ancestorCmdNames;
      }
      return ancestorCmdNames + cmdName + " " + cmd.usage();
    }
    commandDescription(cmd) {
      return cmd.description();
    }
    subcommandDescription(cmd) {
      return cmd.summary() || cmd.description();
    }
    optionDescription(option) {
      const extraInfo = [];
      if (option.argChoices) {
        extraInfo.push(`choices: ${option.argChoices.map((choice) => JSON.stringify(choice)).join(", ")}`);
      }
      if (option.defaultValue !== undefined) {
        const showDefault = option.required || option.optional || option.isBoolean() && typeof option.defaultValue === "boolean";
        if (showDefault) {
          extraInfo.push(`default: ${option.defaultValueDescription || JSON.stringify(option.defaultValue)}`);
        }
      }
      if (option.presetArg !== undefined && option.optional) {
        extraInfo.push(`preset: ${JSON.stringify(option.presetArg)}`);
      }
      if (option.envVar !== undefined) {
        extraInfo.push(`env: ${option.envVar}`);
      }
      if (extraInfo.length > 0) {
        const extraDescription = `(${extraInfo.join(", ")})`;
        if (option.description) {
          return `${option.description} ${extraDescription}`;
        }
        return extraDescription;
      }
      return option.description;
    }
    argumentDescription(argument) {
      const extraInfo = [];
      if (argument.argChoices) {
        extraInfo.push(`choices: ${argument.argChoices.map((choice) => JSON.stringify(choice)).join(", ")}`);
      }
      if (argument.defaultValue !== undefined) {
        extraInfo.push(`default: ${argument.defaultValueDescription || JSON.stringify(argument.defaultValue)}`);
      }
      if (extraInfo.length > 0) {
        const extraDescription = `(${extraInfo.join(", ")})`;
        if (argument.description) {
          return `${argument.description} ${extraDescription}`;
        }
        return extraDescription;
      }
      return argument.description;
    }
    formatItemList(heading, items, helper) {
      if (items.length === 0)
        return [];
      return [helper.styleTitle(heading), ...items, ""];
    }
    groupItems(unsortedItems, visibleItems, getGroup) {
      const result = new Map;
      unsortedItems.forEach((item) => {
        const group = getGroup(item);
        if (!result.has(group))
          result.set(group, []);
      });
      visibleItems.forEach((item) => {
        const group = getGroup(item);
        if (!result.has(group)) {
          result.set(group, []);
        }
        result.get(group).push(item);
      });
      return result;
    }
    formatHelp(cmd, helper) {
      const termWidth = helper.padWidth(cmd, helper);
      const helpWidth = helper.helpWidth ?? 80;
      function callFormatItem(term, description) {
        return helper.formatItem(term, termWidth, description, helper);
      }
      let output = [
        `${helper.styleTitle("Usage:")} ${helper.styleUsage(helper.commandUsage(cmd))}`,
        ""
      ];
      const commandDescription = helper.commandDescription(cmd);
      if (commandDescription.length > 0) {
        output = output.concat([
          helper.boxWrap(helper.styleCommandDescription(commandDescription), helpWidth),
          ""
        ]);
      }
      const argumentList = helper.visibleArguments(cmd).map((argument) => {
        return callFormatItem(helper.styleArgumentTerm(helper.argumentTerm(argument)), helper.styleArgumentDescription(helper.argumentDescription(argument)));
      });
      output = output.concat(this.formatItemList("Arguments:", argumentList, helper));
      const optionGroups = this.groupItems(cmd.options, helper.visibleOptions(cmd), (option) => option.helpGroupHeading ?? "Options:");
      optionGroups.forEach((options, group) => {
        const optionList = options.map((option) => {
          return callFormatItem(helper.styleOptionTerm(helper.optionTerm(option)), helper.styleOptionDescription(helper.optionDescription(option)));
        });
        output = output.concat(this.formatItemList(group, optionList, helper));
      });
      if (helper.showGlobalOptions) {
        const globalOptionList = helper.visibleGlobalOptions(cmd).map((option) => {
          return callFormatItem(helper.styleOptionTerm(helper.optionTerm(option)), helper.styleOptionDescription(helper.optionDescription(option)));
        });
        output = output.concat(this.formatItemList("Global Options:", globalOptionList, helper));
      }
      const commandGroups = this.groupItems(cmd.commands, helper.visibleCommands(cmd), (sub) => sub.helpGroup() || "Commands:");
      commandGroups.forEach((commands, group) => {
        const commandList = commands.map((sub) => {
          return callFormatItem(helper.styleSubcommandTerm(helper.subcommandTerm(sub)), helper.styleSubcommandDescription(helper.subcommandDescription(sub)));
        });
        output = output.concat(this.formatItemList(group, commandList, helper));
      });
      return output.join(`
`);
    }
    displayWidth(str) {
      return stripColor(str).length;
    }
    styleTitle(str) {
      return str;
    }
    styleUsage(str) {
      return str.split(" ").map((word) => {
        if (word === "[options]")
          return this.styleOptionText(word);
        if (word === "[command]")
          return this.styleSubcommandText(word);
        if (word[0] === "[" || word[0] === "<")
          return this.styleArgumentText(word);
        return this.styleCommandText(word);
      }).join(" ");
    }
    styleCommandDescription(str) {
      return this.styleDescriptionText(str);
    }
    styleOptionDescription(str) {
      return this.styleDescriptionText(str);
    }
    styleSubcommandDescription(str) {
      return this.styleDescriptionText(str);
    }
    styleArgumentDescription(str) {
      return this.styleDescriptionText(str);
    }
    styleDescriptionText(str) {
      return str;
    }
    styleOptionTerm(str) {
      return this.styleOptionText(str);
    }
    styleSubcommandTerm(str) {
      return str.split(" ").map((word) => {
        if (word === "[options]")
          return this.styleOptionText(word);
        if (word[0] === "[" || word[0] === "<")
          return this.styleArgumentText(word);
        return this.styleSubcommandText(word);
      }).join(" ");
    }
    styleArgumentTerm(str) {
      return this.styleArgumentText(str);
    }
    styleOptionText(str) {
      return str;
    }
    styleArgumentText(str) {
      return str;
    }
    styleSubcommandText(str) {
      return str;
    }
    styleCommandText(str) {
      return str;
    }
    padWidth(cmd, helper) {
      return Math.max(helper.longestOptionTermLength(cmd, helper), helper.longestGlobalOptionTermLength(cmd, helper), helper.longestSubcommandTermLength(cmd, helper), helper.longestArgumentTermLength(cmd, helper));
    }
    preformatted(str) {
      return /\n[^\S\r\n]/.test(str);
    }
    formatItem(term, termWidth, description, helper) {
      const itemIndent = 2;
      const itemIndentStr = " ".repeat(itemIndent);
      if (!description)
        return itemIndentStr + term;
      const paddedTerm = term.padEnd(termWidth + term.length - helper.displayWidth(term));
      const spacerWidth = 2;
      const helpWidth = this.helpWidth ?? 80;
      const remainingWidth = helpWidth - termWidth - spacerWidth - itemIndent;
      let formattedDescription;
      if (remainingWidth < this.minWidthToWrap || helper.preformatted(description)) {
        formattedDescription = description;
      } else {
        const wrappedDescription = helper.boxWrap(description, remainingWidth);
        formattedDescription = wrappedDescription.replace(/\n/g, `
` + " ".repeat(termWidth + spacerWidth));
      }
      return itemIndentStr + paddedTerm + " ".repeat(spacerWidth) + formattedDescription.replace(/\n/g, `
${itemIndentStr}`);
    }
    boxWrap(str, width) {
      if (width < this.minWidthToWrap)
        return str;
      const rawLines = str.split(/\r\n|\n/);
      const chunkPattern = /[\s]*[^\s]+/g;
      const wrappedLines = [];
      rawLines.forEach((line) => {
        const chunks = line.match(chunkPattern);
        if (chunks === null) {
          wrappedLines.push("");
          return;
        }
        let sumChunks = [chunks.shift()];
        let sumWidth = this.displayWidth(sumChunks[0]);
        chunks.forEach((chunk) => {
          const visibleWidth = this.displayWidth(chunk);
          if (sumWidth + visibleWidth <= width) {
            sumChunks.push(chunk);
            sumWidth += visibleWidth;
            return;
          }
          wrappedLines.push(sumChunks.join(""));
          const nextChunk = chunk.trimStart();
          sumChunks = [nextChunk];
          sumWidth = this.displayWidth(nextChunk);
        });
        wrappedLines.push(sumChunks.join(""));
      });
      return wrappedLines.join(`
`);
    }
  }
  function stripColor(str) {
    const sgrPattern = /\x1b\[\d*(;\d*)*m/g;
    return str.replace(sgrPattern, "");
  }
  exports.Help = Help;
  exports.stripColor = stripColor;
});

// node_modules/commander/lib/option.js
var require_option = __commonJS((exports) => {
  var { InvalidArgumentError } = require_error();

  class Option {
    constructor(flags, description) {
      this.flags = flags;
      this.description = description || "";
      this.required = flags.includes("<");
      this.optional = flags.includes("[");
      this.variadic = /\w\.\.\.[>\]]$/.test(flags);
      this.mandatory = false;
      const optionFlags = splitOptionFlags(flags);
      this.short = optionFlags.shortFlag;
      this.long = optionFlags.longFlag;
      this.negate = false;
      if (this.long) {
        this.negate = this.long.startsWith("--no-");
      }
      this.defaultValue = undefined;
      this.defaultValueDescription = undefined;
      this.presetArg = undefined;
      this.envVar = undefined;
      this.parseArg = undefined;
      this.hidden = false;
      this.argChoices = undefined;
      this.conflictsWith = [];
      this.implied = undefined;
      this.helpGroupHeading = undefined;
    }
    default(value, description) {
      this.defaultValue = value;
      this.defaultValueDescription = description;
      return this;
    }
    preset(arg) {
      this.presetArg = arg;
      return this;
    }
    conflicts(names) {
      this.conflictsWith = this.conflictsWith.concat(names);
      return this;
    }
    implies(impliedOptionValues) {
      let newImplied = impliedOptionValues;
      if (typeof impliedOptionValues === "string") {
        newImplied = { [impliedOptionValues]: true };
      }
      this.implied = Object.assign(this.implied || {}, newImplied);
      return this;
    }
    env(name) {
      this.envVar = name;
      return this;
    }
    argParser(fn) {
      this.parseArg = fn;
      return this;
    }
    makeOptionMandatory(mandatory = true) {
      this.mandatory = !!mandatory;
      return this;
    }
    hideHelp(hide = true) {
      this.hidden = !!hide;
      return this;
    }
    _collectValue(value, previous) {
      if (previous === this.defaultValue || !Array.isArray(previous)) {
        return [value];
      }
      previous.push(value);
      return previous;
    }
    choices(values) {
      this.argChoices = values.slice();
      this.parseArg = (arg, previous) => {
        if (!this.argChoices.includes(arg)) {
          throw new InvalidArgumentError(`Allowed choices are ${this.argChoices.join(", ")}.`);
        }
        if (this.variadic) {
          return this._collectValue(arg, previous);
        }
        return arg;
      };
      return this;
    }
    name() {
      if (this.long) {
        return this.long.replace(/^--/, "");
      }
      return this.short.replace(/^-/, "");
    }
    attributeName() {
      if (this.negate) {
        return camelcase(this.name().replace(/^no-/, ""));
      }
      return camelcase(this.name());
    }
    helpGroup(heading) {
      this.helpGroupHeading = heading;
      return this;
    }
    is(arg) {
      return this.short === arg || this.long === arg;
    }
    isBoolean() {
      return !this.required && !this.optional && !this.negate;
    }
  }

  class DualOptions {
    constructor(options) {
      this.positiveOptions = new Map;
      this.negativeOptions = new Map;
      this.dualOptions = new Set;
      options.forEach((option) => {
        if (option.negate) {
          this.negativeOptions.set(option.attributeName(), option);
        } else {
          this.positiveOptions.set(option.attributeName(), option);
        }
      });
      this.negativeOptions.forEach((value, key) => {
        if (this.positiveOptions.has(key)) {
          this.dualOptions.add(key);
        }
      });
    }
    valueFromOption(value, option) {
      const optionKey = option.attributeName();
      if (!this.dualOptions.has(optionKey))
        return true;
      const preset = this.negativeOptions.get(optionKey).presetArg;
      const negativeValue = preset !== undefined ? preset : false;
      return option.negate === (negativeValue === value);
    }
  }
  function camelcase(str) {
    return str.split("-").reduce((str2, word) => {
      return str2 + word[0].toUpperCase() + word.slice(1);
    });
  }
  function splitOptionFlags(flags) {
    let shortFlag;
    let longFlag;
    const shortFlagExp = /^-[^-]$/;
    const longFlagExp = /^--[^-]/;
    const flagParts = flags.split(/[ |,]+/).concat("guard");
    if (shortFlagExp.test(flagParts[0]))
      shortFlag = flagParts.shift();
    if (longFlagExp.test(flagParts[0]))
      longFlag = flagParts.shift();
    if (!shortFlag && shortFlagExp.test(flagParts[0]))
      shortFlag = flagParts.shift();
    if (!shortFlag && longFlagExp.test(flagParts[0])) {
      shortFlag = longFlag;
      longFlag = flagParts.shift();
    }
    if (flagParts[0].startsWith("-")) {
      const unsupportedFlag = flagParts[0];
      const baseError = `option creation failed due to '${unsupportedFlag}' in option flags '${flags}'`;
      if (/^-[^-][^-]/.test(unsupportedFlag))
        throw new Error(`${baseError}
- a short flag is a single dash and a single character
  - either use a single dash and a single character (for a short flag)
  - or use a double dash for a long option (and can have two, like '--ws, --workspace')`);
      if (shortFlagExp.test(unsupportedFlag))
        throw new Error(`${baseError}
- too many short flags`);
      if (longFlagExp.test(unsupportedFlag))
        throw new Error(`${baseError}
- too many long flags`);
      throw new Error(`${baseError}
- unrecognised flag format`);
    }
    if (shortFlag === undefined && longFlag === undefined)
      throw new Error(`option creation failed due to no flags found in '${flags}'.`);
    return { shortFlag, longFlag };
  }
  exports.Option = Option;
  exports.DualOptions = DualOptions;
});

// node_modules/commander/lib/suggestSimilar.js
var require_suggestSimilar = __commonJS((exports) => {
  var maxDistance = 3;
  function editDistance(a, b) {
    if (Math.abs(a.length - b.length) > maxDistance)
      return Math.max(a.length, b.length);
    const d = [];
    for (let i = 0;i <= a.length; i++) {
      d[i] = [i];
    }
    for (let j = 0;j <= b.length; j++) {
      d[0][j] = j;
    }
    for (let j = 1;j <= b.length; j++) {
      for (let i = 1;i <= a.length; i++) {
        let cost = 1;
        if (a[i - 1] === b[j - 1]) {
          cost = 0;
        } else {
          cost = 1;
        }
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
          d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
        }
      }
    }
    return d[a.length][b.length];
  }
  function suggestSimilar(word, candidates) {
    if (!candidates || candidates.length === 0)
      return "";
    candidates = Array.from(new Set(candidates));
    const searchingOptions = word.startsWith("--");
    if (searchingOptions) {
      word = word.slice(2);
      candidates = candidates.map((candidate) => candidate.slice(2));
    }
    let similar = [];
    let bestDistance = maxDistance;
    const minSimilarity = 0.4;
    candidates.forEach((candidate) => {
      if (candidate.length <= 1)
        return;
      const distance = editDistance(word, candidate);
      const length = Math.max(word.length, candidate.length);
      const similarity = (length - distance) / length;
      if (similarity > minSimilarity) {
        if (distance < bestDistance) {
          bestDistance = distance;
          similar = [candidate];
        } else if (distance === bestDistance) {
          similar.push(candidate);
        }
      }
    });
    similar.sort((a, b) => a.localeCompare(b));
    if (searchingOptions) {
      similar = similar.map((candidate) => `--${candidate}`);
    }
    if (similar.length > 1) {
      return `
(Did you mean one of ${similar.join(", ")}?)`;
    }
    if (similar.length === 1) {
      return `
(Did you mean ${similar[0]}?)`;
    }
    return "";
  }
  exports.suggestSimilar = suggestSimilar;
});

// node_modules/commander/lib/command.js
var require_command = __commonJS((exports) => {
  var EventEmitter = __require("node:events").EventEmitter;
  var childProcess = __require("node:child_process");
  var path = __require("node:path");
  var fs = __require("node:fs");
  var process2 = __require("node:process");
  var { Argument, humanReadableArgName } = require_argument();
  var { CommanderError } = require_error();
  var { Help, stripColor } = require_help();
  var { Option, DualOptions } = require_option();
  var { suggestSimilar } = require_suggestSimilar();

  class Command extends EventEmitter {
    constructor(name) {
      super();
      this.commands = [];
      this.options = [];
      this.parent = null;
      this._allowUnknownOption = false;
      this._allowExcessArguments = false;
      this.registeredArguments = [];
      this._args = this.registeredArguments;
      this.args = [];
      this.rawArgs = [];
      this.processedArgs = [];
      this._scriptPath = null;
      this._name = name || "";
      this._optionValues = {};
      this._optionValueSources = {};
      this._storeOptionsAsProperties = false;
      this._actionHandler = null;
      this._executableHandler = false;
      this._executableFile = null;
      this._executableDir = null;
      this._defaultCommandName = null;
      this._exitCallback = null;
      this._aliases = [];
      this._combineFlagAndOptionalValue = true;
      this._description = "";
      this._summary = "";
      this._argsDescription = undefined;
      this._enablePositionalOptions = false;
      this._passThroughOptions = false;
      this._lifeCycleHooks = {};
      this._showHelpAfterError = false;
      this._showSuggestionAfterError = true;
      this._savedState = null;
      this._outputConfiguration = {
        writeOut: (str) => process2.stdout.write(str),
        writeErr: (str) => process2.stderr.write(str),
        outputError: (str, write) => write(str),
        getOutHelpWidth: () => process2.stdout.isTTY ? process2.stdout.columns : undefined,
        getErrHelpWidth: () => process2.stderr.isTTY ? process2.stderr.columns : undefined,
        getOutHasColors: () => useColor() ?? (process2.stdout.isTTY && process2.stdout.hasColors?.()),
        getErrHasColors: () => useColor() ?? (process2.stderr.isTTY && process2.stderr.hasColors?.()),
        stripColor: (str) => stripColor(str)
      };
      this._hidden = false;
      this._helpOption = undefined;
      this._addImplicitHelpCommand = undefined;
      this._helpCommand = undefined;
      this._helpConfiguration = {};
      this._helpGroupHeading = undefined;
      this._defaultCommandGroup = undefined;
      this._defaultOptionGroup = undefined;
    }
    copyInheritedSettings(sourceCommand) {
      this._outputConfiguration = sourceCommand._outputConfiguration;
      this._helpOption = sourceCommand._helpOption;
      this._helpCommand = sourceCommand._helpCommand;
      this._helpConfiguration = sourceCommand._helpConfiguration;
      this._exitCallback = sourceCommand._exitCallback;
      this._storeOptionsAsProperties = sourceCommand._storeOptionsAsProperties;
      this._combineFlagAndOptionalValue = sourceCommand._combineFlagAndOptionalValue;
      this._allowExcessArguments = sourceCommand._allowExcessArguments;
      this._enablePositionalOptions = sourceCommand._enablePositionalOptions;
      this._showHelpAfterError = sourceCommand._showHelpAfterError;
      this._showSuggestionAfterError = sourceCommand._showSuggestionAfterError;
      return this;
    }
    _getCommandAndAncestors() {
      const result = [];
      for (let command = this;command; command = command.parent) {
        result.push(command);
      }
      return result;
    }
    command(nameAndArgs, actionOptsOrExecDesc, execOpts) {
      let desc = actionOptsOrExecDesc;
      let opts = execOpts;
      if (typeof desc === "object" && desc !== null) {
        opts = desc;
        desc = null;
      }
      opts = opts || {};
      const [, name, args] = nameAndArgs.match(/([^ ]+) *(.*)/);
      const cmd = this.createCommand(name);
      if (desc) {
        cmd.description(desc);
        cmd._executableHandler = true;
      }
      if (opts.isDefault)
        this._defaultCommandName = cmd._name;
      cmd._hidden = !!(opts.noHelp || opts.hidden);
      cmd._executableFile = opts.executableFile || null;
      if (args)
        cmd.arguments(args);
      this._registerCommand(cmd);
      cmd.parent = this;
      cmd.copyInheritedSettings(this);
      if (desc)
        return this;
      return cmd;
    }
    createCommand(name) {
      return new Command(name);
    }
    createHelp() {
      return Object.assign(new Help, this.configureHelp());
    }
    configureHelp(configuration) {
      if (configuration === undefined)
        return this._helpConfiguration;
      this._helpConfiguration = configuration;
      return this;
    }
    configureOutput(configuration) {
      if (configuration === undefined)
        return this._outputConfiguration;
      this._outputConfiguration = {
        ...this._outputConfiguration,
        ...configuration
      };
      return this;
    }
    showHelpAfterError(displayHelp = true) {
      if (typeof displayHelp !== "string")
        displayHelp = !!displayHelp;
      this._showHelpAfterError = displayHelp;
      return this;
    }
    showSuggestionAfterError(displaySuggestion = true) {
      this._showSuggestionAfterError = !!displaySuggestion;
      return this;
    }
    addCommand(cmd, opts) {
      if (!cmd._name) {
        throw new Error(`Command passed to .addCommand() must have a name
- specify the name in Command constructor or using .name()`);
      }
      opts = opts || {};
      if (opts.isDefault)
        this._defaultCommandName = cmd._name;
      if (opts.noHelp || opts.hidden)
        cmd._hidden = true;
      this._registerCommand(cmd);
      cmd.parent = this;
      cmd._checkForBrokenPassThrough();
      return this;
    }
    createArgument(name, description) {
      return new Argument(name, description);
    }
    argument(name, description, parseArg, defaultValue) {
      const argument = this.createArgument(name, description);
      if (typeof parseArg === "function") {
        argument.default(defaultValue).argParser(parseArg);
      } else {
        argument.default(parseArg);
      }
      this.addArgument(argument);
      return this;
    }
    arguments(names) {
      names.trim().split(/ +/).forEach((detail) => {
        this.argument(detail);
      });
      return this;
    }
    addArgument(argument) {
      const previousArgument = this.registeredArguments.slice(-1)[0];
      if (previousArgument?.variadic) {
        throw new Error(`only the last argument can be variadic '${previousArgument.name()}'`);
      }
      if (argument.required && argument.defaultValue !== undefined && argument.parseArg === undefined) {
        throw new Error(`a default value for a required argument is never used: '${argument.name()}'`);
      }
      this.registeredArguments.push(argument);
      return this;
    }
    helpCommand(enableOrNameAndArgs, description) {
      if (typeof enableOrNameAndArgs === "boolean") {
        this._addImplicitHelpCommand = enableOrNameAndArgs;
        if (enableOrNameAndArgs && this._defaultCommandGroup) {
          this._initCommandGroup(this._getHelpCommand());
        }
        return this;
      }
      const nameAndArgs = enableOrNameAndArgs ?? "help [command]";
      const [, helpName, helpArgs] = nameAndArgs.match(/([^ ]+) *(.*)/);
      const helpDescription = description ?? "display help for command";
      const helpCommand = this.createCommand(helpName);
      helpCommand.helpOption(false);
      if (helpArgs)
        helpCommand.arguments(helpArgs);
      if (helpDescription)
        helpCommand.description(helpDescription);
      this._addImplicitHelpCommand = true;
      this._helpCommand = helpCommand;
      if (enableOrNameAndArgs || description)
        this._initCommandGroup(helpCommand);
      return this;
    }
    addHelpCommand(helpCommand, deprecatedDescription) {
      if (typeof helpCommand !== "object") {
        this.helpCommand(helpCommand, deprecatedDescription);
        return this;
      }
      this._addImplicitHelpCommand = true;
      this._helpCommand = helpCommand;
      this._initCommandGroup(helpCommand);
      return this;
    }
    _getHelpCommand() {
      const hasImplicitHelpCommand = this._addImplicitHelpCommand ?? (this.commands.length && !this._actionHandler && !this._findCommand("help"));
      if (hasImplicitHelpCommand) {
        if (this._helpCommand === undefined) {
          this.helpCommand(undefined, undefined);
        }
        return this._helpCommand;
      }
      return null;
    }
    hook(event, listener) {
      const allowedValues = ["preSubcommand", "preAction", "postAction"];
      if (!allowedValues.includes(event)) {
        throw new Error(`Unexpected value for event passed to hook : '${event}'.
Expecting one of '${allowedValues.join("', '")}'`);
      }
      if (this._lifeCycleHooks[event]) {
        this._lifeCycleHooks[event].push(listener);
      } else {
        this._lifeCycleHooks[event] = [listener];
      }
      return this;
    }
    exitOverride(fn) {
      if (fn) {
        this._exitCallback = fn;
      } else {
        this._exitCallback = (err) => {
          if (err.code !== "commander.executeSubCommandAsync") {
            throw err;
          } else {}
        };
      }
      return this;
    }
    _exit(exitCode, code, message) {
      if (this._exitCallback) {
        this._exitCallback(new CommanderError(exitCode, code, message));
      }
      process2.exit(exitCode);
    }
    action(fn) {
      const listener = (args) => {
        const expectedArgsCount = this.registeredArguments.length;
        const actionArgs = args.slice(0, expectedArgsCount);
        if (this._storeOptionsAsProperties) {
          actionArgs[expectedArgsCount] = this;
        } else {
          actionArgs[expectedArgsCount] = this.opts();
        }
        actionArgs.push(this);
        return fn.apply(this, actionArgs);
      };
      this._actionHandler = listener;
      return this;
    }
    createOption(flags, description) {
      return new Option(flags, description);
    }
    _callParseArg(target, value, previous, invalidArgumentMessage) {
      try {
        return target.parseArg(value, previous);
      } catch (err) {
        if (err.code === "commander.invalidArgument") {
          const message = `${invalidArgumentMessage} ${err.message}`;
          this.error(message, { exitCode: err.exitCode, code: err.code });
        }
        throw err;
      }
    }
    _registerOption(option) {
      const matchingOption = option.short && this._findOption(option.short) || option.long && this._findOption(option.long);
      if (matchingOption) {
        const matchingFlag = option.long && this._findOption(option.long) ? option.long : option.short;
        throw new Error(`Cannot add option '${option.flags}'${this._name && ` to command '${this._name}'`} due to conflicting flag '${matchingFlag}'
-  already used by option '${matchingOption.flags}'`);
      }
      this._initOptionGroup(option);
      this.options.push(option);
    }
    _registerCommand(command) {
      const knownBy = (cmd) => {
        return [cmd.name()].concat(cmd.aliases());
      };
      const alreadyUsed = knownBy(command).find((name) => this._findCommand(name));
      if (alreadyUsed) {
        const existingCmd = knownBy(this._findCommand(alreadyUsed)).join("|");
        const newCmd = knownBy(command).join("|");
        throw new Error(`cannot add command '${newCmd}' as already have command '${existingCmd}'`);
      }
      this._initCommandGroup(command);
      this.commands.push(command);
    }
    addOption(option) {
      this._registerOption(option);
      const oname = option.name();
      const name = option.attributeName();
      if (option.negate) {
        const positiveLongFlag = option.long.replace(/^--no-/, "--");
        if (!this._findOption(positiveLongFlag)) {
          this.setOptionValueWithSource(name, option.defaultValue === undefined ? true : option.defaultValue, "default");
        }
      } else if (option.defaultValue !== undefined) {
        this.setOptionValueWithSource(name, option.defaultValue, "default");
      }
      const handleOptionValue = (val, invalidValueMessage, valueSource) => {
        if (val == null && option.presetArg !== undefined) {
          val = option.presetArg;
        }
        const oldValue = this.getOptionValue(name);
        if (val !== null && option.parseArg) {
          val = this._callParseArg(option, val, oldValue, invalidValueMessage);
        } else if (val !== null && option.variadic) {
          val = option._collectValue(val, oldValue);
        }
        if (val == null) {
          if (option.negate) {
            val = false;
          } else if (option.isBoolean() || option.optional) {
            val = true;
          } else {
            val = "";
          }
        }
        this.setOptionValueWithSource(name, val, valueSource);
      };
      this.on("option:" + oname, (val) => {
        const invalidValueMessage = `error: option '${option.flags}' argument '${val}' is invalid.`;
        handleOptionValue(val, invalidValueMessage, "cli");
      });
      if (option.envVar) {
        this.on("optionEnv:" + oname, (val) => {
          const invalidValueMessage = `error: option '${option.flags}' value '${val}' from env '${option.envVar}' is invalid.`;
          handleOptionValue(val, invalidValueMessage, "env");
        });
      }
      return this;
    }
    _optionEx(config, flags, description, fn, defaultValue) {
      if (typeof flags === "object" && flags instanceof Option) {
        throw new Error("To add an Option object use addOption() instead of option() or requiredOption()");
      }
      const option = this.createOption(flags, description);
      option.makeOptionMandatory(!!config.mandatory);
      if (typeof fn === "function") {
        option.default(defaultValue).argParser(fn);
      } else if (fn instanceof RegExp) {
        const regex = fn;
        fn = (val, def) => {
          const m = regex.exec(val);
          return m ? m[0] : def;
        };
        option.default(defaultValue).argParser(fn);
      } else {
        option.default(fn);
      }
      return this.addOption(option);
    }
    option(flags, description, parseArg, defaultValue) {
      return this._optionEx({}, flags, description, parseArg, defaultValue);
    }
    requiredOption(flags, description, parseArg, defaultValue) {
      return this._optionEx({ mandatory: true }, flags, description, parseArg, defaultValue);
    }
    combineFlagAndOptionalValue(combine = true) {
      this._combineFlagAndOptionalValue = !!combine;
      return this;
    }
    allowUnknownOption(allowUnknown = true) {
      this._allowUnknownOption = !!allowUnknown;
      return this;
    }
    allowExcessArguments(allowExcess = true) {
      this._allowExcessArguments = !!allowExcess;
      return this;
    }
    enablePositionalOptions(positional = true) {
      this._enablePositionalOptions = !!positional;
      return this;
    }
    passThroughOptions(passThrough = true) {
      this._passThroughOptions = !!passThrough;
      this._checkForBrokenPassThrough();
      return this;
    }
    _checkForBrokenPassThrough() {
      if (this.parent && this._passThroughOptions && !this.parent._enablePositionalOptions) {
        throw new Error(`passThroughOptions cannot be used for '${this._name}' without turning on enablePositionalOptions for parent command(s)`);
      }
    }
    storeOptionsAsProperties(storeAsProperties = true) {
      if (this.options.length) {
        throw new Error("call .storeOptionsAsProperties() before adding options");
      }
      if (Object.keys(this._optionValues).length) {
        throw new Error("call .storeOptionsAsProperties() before setting option values");
      }
      this._storeOptionsAsProperties = !!storeAsProperties;
      return this;
    }
    getOptionValue(key) {
      if (this._storeOptionsAsProperties) {
        return this[key];
      }
      return this._optionValues[key];
    }
    setOptionValue(key, value) {
      return this.setOptionValueWithSource(key, value, undefined);
    }
    setOptionValueWithSource(key, value, source) {
      if (this._storeOptionsAsProperties) {
        this[key] = value;
      } else {
        this._optionValues[key] = value;
      }
      this._optionValueSources[key] = source;
      return this;
    }
    getOptionValueSource(key) {
      return this._optionValueSources[key];
    }
    getOptionValueSourceWithGlobals(key) {
      let source;
      this._getCommandAndAncestors().forEach((cmd) => {
        if (cmd.getOptionValueSource(key) !== undefined) {
          source = cmd.getOptionValueSource(key);
        }
      });
      return source;
    }
    _prepareUserArgs(argv, parseOptions) {
      if (argv !== undefined && !Array.isArray(argv)) {
        throw new Error("first parameter to parse must be array or undefined");
      }
      parseOptions = parseOptions || {};
      if (argv === undefined && parseOptions.from === undefined) {
        if (process2.versions?.electron) {
          parseOptions.from = "electron";
        }
        const execArgv = process2.execArgv ?? [];
        if (execArgv.includes("-e") || execArgv.includes("--eval") || execArgv.includes("-p") || execArgv.includes("--print")) {
          parseOptions.from = "eval";
        }
      }
      if (argv === undefined) {
        argv = process2.argv;
      }
      this.rawArgs = argv.slice();
      let userArgs;
      switch (parseOptions.from) {
        case undefined:
        case "node":
          this._scriptPath = argv[1];
          userArgs = argv.slice(2);
          break;
        case "electron":
          if (process2.defaultApp) {
            this._scriptPath = argv[1];
            userArgs = argv.slice(2);
          } else {
            userArgs = argv.slice(1);
          }
          break;
        case "user":
          userArgs = argv.slice(0);
          break;
        case "eval":
          userArgs = argv.slice(1);
          break;
        default:
          throw new Error(`unexpected parse option { from: '${parseOptions.from}' }`);
      }
      if (!this._name && this._scriptPath)
        this.nameFromFilename(this._scriptPath);
      this._name = this._name || "program";
      return userArgs;
    }
    parse(argv, parseOptions) {
      this._prepareForParse();
      const userArgs = this._prepareUserArgs(argv, parseOptions);
      this._parseCommand([], userArgs);
      return this;
    }
    async parseAsync(argv, parseOptions) {
      this._prepareForParse();
      const userArgs = this._prepareUserArgs(argv, parseOptions);
      await this._parseCommand([], userArgs);
      return this;
    }
    _prepareForParse() {
      if (this._savedState === null) {
        this.saveStateBeforeParse();
      } else {
        this.restoreStateBeforeParse();
      }
    }
    saveStateBeforeParse() {
      this._savedState = {
        _name: this._name,
        _optionValues: { ...this._optionValues },
        _optionValueSources: { ...this._optionValueSources }
      };
    }
    restoreStateBeforeParse() {
      if (this._storeOptionsAsProperties)
        throw new Error(`Can not call parse again when storeOptionsAsProperties is true.
- either make a new Command for each call to parse, or stop storing options as properties`);
      this._name = this._savedState._name;
      this._scriptPath = null;
      this.rawArgs = [];
      this._optionValues = { ...this._savedState._optionValues };
      this._optionValueSources = { ...this._savedState._optionValueSources };
      this.args = [];
      this.processedArgs = [];
    }
    _checkForMissingExecutable(executableFile, executableDir, subcommandName) {
      if (fs.existsSync(executableFile))
        return;
      const executableDirMessage = executableDir ? `searched for local subcommand relative to directory '${executableDir}'` : "no directory for search for local subcommand, use .executableDir() to supply a custom directory";
      const executableMissing = `'${executableFile}' does not exist
 - if '${subcommandName}' is not meant to be an executable command, remove description parameter from '.command()' and use '.description()' instead
 - if the default executable name is not suitable, use the executableFile option to supply a custom name or path
 - ${executableDirMessage}`;
      throw new Error(executableMissing);
    }
    _executeSubCommand(subcommand, args) {
      args = args.slice();
      let launchWithNode = false;
      const sourceExt = [".js", ".ts", ".tsx", ".mjs", ".cjs"];
      function findFile(baseDir, baseName) {
        const localBin = path.resolve(baseDir, baseName);
        if (fs.existsSync(localBin))
          return localBin;
        if (sourceExt.includes(path.extname(baseName)))
          return;
        const foundExt = sourceExt.find((ext) => fs.existsSync(`${localBin}${ext}`));
        if (foundExt)
          return `${localBin}${foundExt}`;
        return;
      }
      this._checkForMissingMandatoryOptions();
      this._checkForConflictingOptions();
      let executableFile = subcommand._executableFile || `${this._name}-${subcommand._name}`;
      let executableDir = this._executableDir || "";
      if (this._scriptPath) {
        let resolvedScriptPath;
        try {
          resolvedScriptPath = fs.realpathSync(this._scriptPath);
        } catch {
          resolvedScriptPath = this._scriptPath;
        }
        executableDir = path.resolve(path.dirname(resolvedScriptPath), executableDir);
      }
      if (executableDir) {
        let localFile = findFile(executableDir, executableFile);
        if (!localFile && !subcommand._executableFile && this._scriptPath) {
          const legacyName = path.basename(this._scriptPath, path.extname(this._scriptPath));
          if (legacyName !== this._name) {
            localFile = findFile(executableDir, `${legacyName}-${subcommand._name}`);
          }
        }
        executableFile = localFile || executableFile;
      }
      launchWithNode = sourceExt.includes(path.extname(executableFile));
      let proc;
      if (process2.platform !== "win32") {
        if (launchWithNode) {
          args.unshift(executableFile);
          args = incrementNodeInspectorPort(process2.execArgv).concat(args);
          proc = childProcess.spawn(process2.argv[0], args, { stdio: "inherit" });
        } else {
          proc = childProcess.spawn(executableFile, args, { stdio: "inherit" });
        }
      } else {
        this._checkForMissingExecutable(executableFile, executableDir, subcommand._name);
        args.unshift(executableFile);
        args = incrementNodeInspectorPort(process2.execArgv).concat(args);
        proc = childProcess.spawn(process2.execPath, args, { stdio: "inherit" });
      }
      if (!proc.killed) {
        const signals = ["SIGUSR1", "SIGUSR2", "SIGTERM", "SIGINT", "SIGHUP"];
        signals.forEach((signal) => {
          process2.on(signal, () => {
            if (proc.killed === false && proc.exitCode === null) {
              proc.kill(signal);
            }
          });
        });
      }
      const exitCallback = this._exitCallback;
      proc.on("close", (code) => {
        code = code ?? 1;
        if (!exitCallback) {
          process2.exit(code);
        } else {
          exitCallback(new CommanderError(code, "commander.executeSubCommandAsync", "(close)"));
        }
      });
      proc.on("error", (err) => {
        if (err.code === "ENOENT") {
          this._checkForMissingExecutable(executableFile, executableDir, subcommand._name);
        } else if (err.code === "EACCES") {
          throw new Error(`'${executableFile}' not executable`);
        }
        if (!exitCallback) {
          process2.exit(1);
        } else {
          const wrappedError = new CommanderError(1, "commander.executeSubCommandAsync", "(error)");
          wrappedError.nestedError = err;
          exitCallback(wrappedError);
        }
      });
      this.runningCommand = proc;
    }
    _dispatchSubcommand(commandName, operands, unknown) {
      const subCommand = this._findCommand(commandName);
      if (!subCommand)
        this.help({ error: true });
      subCommand._prepareForParse();
      let promiseChain;
      promiseChain = this._chainOrCallSubCommandHook(promiseChain, subCommand, "preSubcommand");
      promiseChain = this._chainOrCall(promiseChain, () => {
        if (subCommand._executableHandler) {
          this._executeSubCommand(subCommand, operands.concat(unknown));
        } else {
          return subCommand._parseCommand(operands, unknown);
        }
      });
      return promiseChain;
    }
    _dispatchHelpCommand(subcommandName) {
      if (!subcommandName) {
        this.help();
      }
      const subCommand = this._findCommand(subcommandName);
      if (subCommand && !subCommand._executableHandler) {
        subCommand.help();
      }
      return this._dispatchSubcommand(subcommandName, [], [this._getHelpOption()?.long ?? this._getHelpOption()?.short ?? "--help"]);
    }
    _checkNumberOfArguments() {
      this.registeredArguments.forEach((arg, i) => {
        if (arg.required && this.args[i] == null) {
          this.missingArgument(arg.name());
        }
      });
      if (this.registeredArguments.length > 0 && this.registeredArguments[this.registeredArguments.length - 1].variadic) {
        return;
      }
      if (this.args.length > this.registeredArguments.length) {
        this._excessArguments(this.args);
      }
    }
    _processArguments() {
      const myParseArg = (argument, value, previous) => {
        let parsedValue = value;
        if (value !== null && argument.parseArg) {
          const invalidValueMessage = `error: command-argument value '${value}' is invalid for argument '${argument.name()}'.`;
          parsedValue = this._callParseArg(argument, value, previous, invalidValueMessage);
        }
        return parsedValue;
      };
      this._checkNumberOfArguments();
      const processedArgs = [];
      this.registeredArguments.forEach((declaredArg, index) => {
        let value = declaredArg.defaultValue;
        if (declaredArg.variadic) {
          if (index < this.args.length) {
            value = this.args.slice(index);
            if (declaredArg.parseArg) {
              value = value.reduce((processed, v) => {
                return myParseArg(declaredArg, v, processed);
              }, declaredArg.defaultValue);
            }
          } else if (value === undefined) {
            value = [];
          }
        } else if (index < this.args.length) {
          value = this.args[index];
          if (declaredArg.parseArg) {
            value = myParseArg(declaredArg, value, declaredArg.defaultValue);
          }
        }
        processedArgs[index] = value;
      });
      this.processedArgs = processedArgs;
    }
    _chainOrCall(promise, fn) {
      if (promise?.then && typeof promise.then === "function") {
        return promise.then(() => fn());
      }
      return fn();
    }
    _chainOrCallHooks(promise, event) {
      let result = promise;
      const hooks = [];
      this._getCommandAndAncestors().reverse().filter((cmd) => cmd._lifeCycleHooks[event] !== undefined).forEach((hookedCommand) => {
        hookedCommand._lifeCycleHooks[event].forEach((callback) => {
          hooks.push({ hookedCommand, callback });
        });
      });
      if (event === "postAction") {
        hooks.reverse();
      }
      hooks.forEach((hookDetail) => {
        result = this._chainOrCall(result, () => {
          return hookDetail.callback(hookDetail.hookedCommand, this);
        });
      });
      return result;
    }
    _chainOrCallSubCommandHook(promise, subCommand, event) {
      let result = promise;
      if (this._lifeCycleHooks[event] !== undefined) {
        this._lifeCycleHooks[event].forEach((hook) => {
          result = this._chainOrCall(result, () => {
            return hook(this, subCommand);
          });
        });
      }
      return result;
    }
    _parseCommand(operands, unknown) {
      const parsed = this.parseOptions(unknown);
      this._parseOptionsEnv();
      this._parseOptionsImplied();
      operands = operands.concat(parsed.operands);
      unknown = parsed.unknown;
      this.args = operands.concat(unknown);
      if (operands && this._findCommand(operands[0])) {
        return this._dispatchSubcommand(operands[0], operands.slice(1), unknown);
      }
      if (this._getHelpCommand() && operands[0] === this._getHelpCommand().name()) {
        return this._dispatchHelpCommand(operands[1]);
      }
      if (this._defaultCommandName) {
        this._outputHelpIfRequested(unknown);
        return this._dispatchSubcommand(this._defaultCommandName, operands, unknown);
      }
      if (this.commands.length && this.args.length === 0 && !this._actionHandler && !this._defaultCommandName) {
        this.help({ error: true });
      }
      this._outputHelpIfRequested(parsed.unknown);
      this._checkForMissingMandatoryOptions();
      this._checkForConflictingOptions();
      const checkForUnknownOptions = () => {
        if (parsed.unknown.length > 0) {
          this.unknownOption(parsed.unknown[0]);
        }
      };
      const commandEvent = `command:${this.name()}`;
      if (this._actionHandler) {
        checkForUnknownOptions();
        this._processArguments();
        let promiseChain;
        promiseChain = this._chainOrCallHooks(promiseChain, "preAction");
        promiseChain = this._chainOrCall(promiseChain, () => this._actionHandler(this.processedArgs));
        if (this.parent) {
          promiseChain = this._chainOrCall(promiseChain, () => {
            this.parent.emit(commandEvent, operands, unknown);
          });
        }
        promiseChain = this._chainOrCallHooks(promiseChain, "postAction");
        return promiseChain;
      }
      if (this.parent?.listenerCount(commandEvent)) {
        checkForUnknownOptions();
        this._processArguments();
        this.parent.emit(commandEvent, operands, unknown);
      } else if (operands.length) {
        if (this._findCommand("*")) {
          return this._dispatchSubcommand("*", operands, unknown);
        }
        if (this.listenerCount("command:*")) {
          this.emit("command:*", operands, unknown);
        } else if (this.commands.length) {
          this.unknownCommand();
        } else {
          checkForUnknownOptions();
          this._processArguments();
        }
      } else if (this.commands.length) {
        checkForUnknownOptions();
        this.help({ error: true });
      } else {
        checkForUnknownOptions();
        this._processArguments();
      }
    }
    _findCommand(name) {
      if (!name)
        return;
      return this.commands.find((cmd) => cmd._name === name || cmd._aliases.includes(name));
    }
    _findOption(arg) {
      return this.options.find((option) => option.is(arg));
    }
    _checkForMissingMandatoryOptions() {
      this._getCommandAndAncestors().forEach((cmd) => {
        cmd.options.forEach((anOption) => {
          if (anOption.mandatory && cmd.getOptionValue(anOption.attributeName()) === undefined) {
            cmd.missingMandatoryOptionValue(anOption);
          }
        });
      });
    }
    _checkForConflictingLocalOptions() {
      const definedNonDefaultOptions = this.options.filter((option) => {
        const optionKey = option.attributeName();
        if (this.getOptionValue(optionKey) === undefined) {
          return false;
        }
        return this.getOptionValueSource(optionKey) !== "default";
      });
      const optionsWithConflicting = definedNonDefaultOptions.filter((option) => option.conflictsWith.length > 0);
      optionsWithConflicting.forEach((option) => {
        const conflictingAndDefined = definedNonDefaultOptions.find((defined) => option.conflictsWith.includes(defined.attributeName()));
        if (conflictingAndDefined) {
          this._conflictingOption(option, conflictingAndDefined);
        }
      });
    }
    _checkForConflictingOptions() {
      this._getCommandAndAncestors().forEach((cmd) => {
        cmd._checkForConflictingLocalOptions();
      });
    }
    parseOptions(args) {
      const operands = [];
      const unknown = [];
      let dest = operands;
      function maybeOption(arg) {
        return arg.length > 1 && arg[0] === "-";
      }
      const negativeNumberArg = (arg) => {
        if (!/^-(\d+|\d*\.\d+)(e[+-]?\d+)?$/.test(arg))
          return false;
        return !this._getCommandAndAncestors().some((cmd) => cmd.options.map((opt) => opt.short).some((short) => /^-\d$/.test(short)));
      };
      let activeVariadicOption = null;
      let activeGroup = null;
      let i = 0;
      while (i < args.length || activeGroup) {
        const arg = activeGroup ?? args[i++];
        activeGroup = null;
        if (arg === "--") {
          if (dest === unknown)
            dest.push(arg);
          dest.push(...args.slice(i));
          break;
        }
        if (activeVariadicOption && (!maybeOption(arg) || negativeNumberArg(arg))) {
          this.emit(`option:${activeVariadicOption.name()}`, arg);
          continue;
        }
        activeVariadicOption = null;
        if (maybeOption(arg)) {
          const option = this._findOption(arg);
          if (option) {
            if (option.required) {
              const value = args[i++];
              if (value === undefined)
                this.optionMissingArgument(option);
              this.emit(`option:${option.name()}`, value);
            } else if (option.optional) {
              let value = null;
              if (i < args.length && (!maybeOption(args[i]) || negativeNumberArg(args[i]))) {
                value = args[i++];
              }
              this.emit(`option:${option.name()}`, value);
            } else {
              this.emit(`option:${option.name()}`);
            }
            activeVariadicOption = option.variadic ? option : null;
            continue;
          }
        }
        if (arg.length > 2 && arg[0] === "-" && arg[1] !== "-") {
          const option = this._findOption(`-${arg[1]}`);
          if (option) {
            if (option.required || option.optional && this._combineFlagAndOptionalValue) {
              this.emit(`option:${option.name()}`, arg.slice(2));
            } else {
              this.emit(`option:${option.name()}`);
              activeGroup = `-${arg.slice(2)}`;
            }
            continue;
          }
        }
        if (/^--[^=]+=/.test(arg)) {
          const index = arg.indexOf("=");
          const option = this._findOption(arg.slice(0, index));
          if (option && (option.required || option.optional)) {
            this.emit(`option:${option.name()}`, arg.slice(index + 1));
            continue;
          }
        }
        if (dest === operands && maybeOption(arg) && !(this.commands.length === 0 && negativeNumberArg(arg))) {
          dest = unknown;
        }
        if ((this._enablePositionalOptions || this._passThroughOptions) && operands.length === 0 && unknown.length === 0) {
          if (this._findCommand(arg)) {
            operands.push(arg);
            unknown.push(...args.slice(i));
            break;
          } else if (this._getHelpCommand() && arg === this._getHelpCommand().name()) {
            operands.push(arg, ...args.slice(i));
            break;
          } else if (this._defaultCommandName) {
            unknown.push(arg, ...args.slice(i));
            break;
          }
        }
        if (this._passThroughOptions) {
          dest.push(arg, ...args.slice(i));
          break;
        }
        dest.push(arg);
      }
      return { operands, unknown };
    }
    opts() {
      if (this._storeOptionsAsProperties) {
        const result = {};
        const len = this.options.length;
        for (let i = 0;i < len; i++) {
          const key = this.options[i].attributeName();
          result[key] = key === this._versionOptionName ? this._version : this[key];
        }
        return result;
      }
      return this._optionValues;
    }
    optsWithGlobals() {
      return this._getCommandAndAncestors().reduce((combinedOptions, cmd) => Object.assign(combinedOptions, cmd.opts()), {});
    }
    error(message, errorOptions) {
      this._outputConfiguration.outputError(`${message}
`, this._outputConfiguration.writeErr);
      if (typeof this._showHelpAfterError === "string") {
        this._outputConfiguration.writeErr(`${this._showHelpAfterError}
`);
      } else if (this._showHelpAfterError) {
        this._outputConfiguration.writeErr(`
`);
        this.outputHelp({ error: true });
      }
      const config = errorOptions || {};
      const exitCode = config.exitCode || 1;
      const code = config.code || "commander.error";
      this._exit(exitCode, code, message);
    }
    _parseOptionsEnv() {
      this.options.forEach((option) => {
        if (option.envVar && option.envVar in process2.env) {
          const optionKey = option.attributeName();
          if (this.getOptionValue(optionKey) === undefined || ["default", "config", "env"].includes(this.getOptionValueSource(optionKey))) {
            if (option.required || option.optional) {
              this.emit(`optionEnv:${option.name()}`, process2.env[option.envVar]);
            } else {
              this.emit(`optionEnv:${option.name()}`);
            }
          }
        }
      });
    }
    _parseOptionsImplied() {
      const dualHelper = new DualOptions(this.options);
      const hasCustomOptionValue = (optionKey) => {
        return this.getOptionValue(optionKey) !== undefined && !["default", "implied"].includes(this.getOptionValueSource(optionKey));
      };
      this.options.filter((option) => option.implied !== undefined && hasCustomOptionValue(option.attributeName()) && dualHelper.valueFromOption(this.getOptionValue(option.attributeName()), option)).forEach((option) => {
        Object.keys(option.implied).filter((impliedKey) => !hasCustomOptionValue(impliedKey)).forEach((impliedKey) => {
          this.setOptionValueWithSource(impliedKey, option.implied[impliedKey], "implied");
        });
      });
    }
    missingArgument(name) {
      const message = `error: missing required argument '${name}'`;
      this.error(message, { code: "commander.missingArgument" });
    }
    optionMissingArgument(option) {
      const message = `error: option '${option.flags}' argument missing`;
      this.error(message, { code: "commander.optionMissingArgument" });
    }
    missingMandatoryOptionValue(option) {
      const message = `error: required option '${option.flags}' not specified`;
      this.error(message, { code: "commander.missingMandatoryOptionValue" });
    }
    _conflictingOption(option, conflictingOption) {
      const findBestOptionFromValue = (option2) => {
        const optionKey = option2.attributeName();
        const optionValue = this.getOptionValue(optionKey);
        const negativeOption = this.options.find((target) => target.negate && optionKey === target.attributeName());
        const positiveOption = this.options.find((target) => !target.negate && optionKey === target.attributeName());
        if (negativeOption && (negativeOption.presetArg === undefined && optionValue === false || negativeOption.presetArg !== undefined && optionValue === negativeOption.presetArg)) {
          return negativeOption;
        }
        return positiveOption || option2;
      };
      const getErrorMessage = (option2) => {
        const bestOption = findBestOptionFromValue(option2);
        const optionKey = bestOption.attributeName();
        const source = this.getOptionValueSource(optionKey);
        if (source === "env") {
          return `environment variable '${bestOption.envVar}'`;
        }
        return `option '${bestOption.flags}'`;
      };
      const message = `error: ${getErrorMessage(option)} cannot be used with ${getErrorMessage(conflictingOption)}`;
      this.error(message, { code: "commander.conflictingOption" });
    }
    unknownOption(flag) {
      if (this._allowUnknownOption)
        return;
      let suggestion = "";
      if (flag.startsWith("--") && this._showSuggestionAfterError) {
        let candidateFlags = [];
        let command = this;
        do {
          const moreFlags = command.createHelp().visibleOptions(command).filter((option) => option.long).map((option) => option.long);
          candidateFlags = candidateFlags.concat(moreFlags);
          command = command.parent;
        } while (command && !command._enablePositionalOptions);
        suggestion = suggestSimilar(flag, candidateFlags);
      }
      const message = `error: unknown option '${flag}'${suggestion}`;
      this.error(message, { code: "commander.unknownOption" });
    }
    _excessArguments(receivedArgs) {
      if (this._allowExcessArguments)
        return;
      const expected = this.registeredArguments.length;
      const s = expected === 1 ? "" : "s";
      const forSubcommand = this.parent ? ` for '${this.name()}'` : "";
      const message = `error: too many arguments${forSubcommand}. Expected ${expected} argument${s} but got ${receivedArgs.length}.`;
      this.error(message, { code: "commander.excessArguments" });
    }
    unknownCommand() {
      const unknownName = this.args[0];
      let suggestion = "";
      if (this._showSuggestionAfterError) {
        const candidateNames = [];
        this.createHelp().visibleCommands(this).forEach((command) => {
          candidateNames.push(command.name());
          if (command.alias())
            candidateNames.push(command.alias());
        });
        suggestion = suggestSimilar(unknownName, candidateNames);
      }
      const message = `error: unknown command '${unknownName}'${suggestion}`;
      this.error(message, { code: "commander.unknownCommand" });
    }
    version(str, flags, description) {
      if (str === undefined)
        return this._version;
      this._version = str;
      flags = flags || "-V, --version";
      description = description || "output the version number";
      const versionOption = this.createOption(flags, description);
      this._versionOptionName = versionOption.attributeName();
      this._registerOption(versionOption);
      this.on("option:" + versionOption.name(), () => {
        this._outputConfiguration.writeOut(`${str}
`);
        this._exit(0, "commander.version", str);
      });
      return this;
    }
    description(str, argsDescription) {
      if (str === undefined && argsDescription === undefined)
        return this._description;
      this._description = str;
      if (argsDescription) {
        this._argsDescription = argsDescription;
      }
      return this;
    }
    summary(str) {
      if (str === undefined)
        return this._summary;
      this._summary = str;
      return this;
    }
    alias(alias) {
      if (alias === undefined)
        return this._aliases[0];
      let command = this;
      if (this.commands.length !== 0 && this.commands[this.commands.length - 1]._executableHandler) {
        command = this.commands[this.commands.length - 1];
      }
      if (alias === command._name)
        throw new Error("Command alias can't be the same as its name");
      const matchingCommand = this.parent?._findCommand(alias);
      if (matchingCommand) {
        const existingCmd = [matchingCommand.name()].concat(matchingCommand.aliases()).join("|");
        throw new Error(`cannot add alias '${alias}' to command '${this.name()}' as already have command '${existingCmd}'`);
      }
      command._aliases.push(alias);
      return this;
    }
    aliases(aliases) {
      if (aliases === undefined)
        return this._aliases;
      aliases.forEach((alias) => this.alias(alias));
      return this;
    }
    usage(str) {
      if (str === undefined) {
        if (this._usage)
          return this._usage;
        const args = this.registeredArguments.map((arg) => {
          return humanReadableArgName(arg);
        });
        return [].concat(this.options.length || this._helpOption !== null ? "[options]" : [], this.commands.length ? "[command]" : [], this.registeredArguments.length ? args : []).join(" ");
      }
      this._usage = str;
      return this;
    }
    name(str) {
      if (str === undefined)
        return this._name;
      this._name = str;
      return this;
    }
    helpGroup(heading) {
      if (heading === undefined)
        return this._helpGroupHeading ?? "";
      this._helpGroupHeading = heading;
      return this;
    }
    commandsGroup(heading) {
      if (heading === undefined)
        return this._defaultCommandGroup ?? "";
      this._defaultCommandGroup = heading;
      return this;
    }
    optionsGroup(heading) {
      if (heading === undefined)
        return this._defaultOptionGroup ?? "";
      this._defaultOptionGroup = heading;
      return this;
    }
    _initOptionGroup(option) {
      if (this._defaultOptionGroup && !option.helpGroupHeading)
        option.helpGroup(this._defaultOptionGroup);
    }
    _initCommandGroup(cmd) {
      if (this._defaultCommandGroup && !cmd.helpGroup())
        cmd.helpGroup(this._defaultCommandGroup);
    }
    nameFromFilename(filename) {
      this._name = path.basename(filename, path.extname(filename));
      return this;
    }
    executableDir(path2) {
      if (path2 === undefined)
        return this._executableDir;
      this._executableDir = path2;
      return this;
    }
    helpInformation(contextOptions) {
      const helper = this.createHelp();
      const context = this._getOutputContext(contextOptions);
      helper.prepareContext({
        error: context.error,
        helpWidth: context.helpWidth,
        outputHasColors: context.hasColors
      });
      const text = helper.formatHelp(this, helper);
      if (context.hasColors)
        return text;
      return this._outputConfiguration.stripColor(text);
    }
    _getOutputContext(contextOptions) {
      contextOptions = contextOptions || {};
      const error = !!contextOptions.error;
      let baseWrite;
      let hasColors;
      let helpWidth;
      if (error) {
        baseWrite = (str) => this._outputConfiguration.writeErr(str);
        hasColors = this._outputConfiguration.getErrHasColors();
        helpWidth = this._outputConfiguration.getErrHelpWidth();
      } else {
        baseWrite = (str) => this._outputConfiguration.writeOut(str);
        hasColors = this._outputConfiguration.getOutHasColors();
        helpWidth = this._outputConfiguration.getOutHelpWidth();
      }
      const write = (str) => {
        if (!hasColors)
          str = this._outputConfiguration.stripColor(str);
        return baseWrite(str);
      };
      return { error, write, hasColors, helpWidth };
    }
    outputHelp(contextOptions) {
      let deprecatedCallback;
      if (typeof contextOptions === "function") {
        deprecatedCallback = contextOptions;
        contextOptions = undefined;
      }
      const outputContext = this._getOutputContext(contextOptions);
      const eventContext = {
        error: outputContext.error,
        write: outputContext.write,
        command: this
      };
      this._getCommandAndAncestors().reverse().forEach((command) => command.emit("beforeAllHelp", eventContext));
      this.emit("beforeHelp", eventContext);
      let helpInformation = this.helpInformation({ error: outputContext.error });
      if (deprecatedCallback) {
        helpInformation = deprecatedCallback(helpInformation);
        if (typeof helpInformation !== "string" && !Buffer.isBuffer(helpInformation)) {
          throw new Error("outputHelp callback must return a string or a Buffer");
        }
      }
      outputContext.write(helpInformation);
      if (this._getHelpOption()?.long) {
        this.emit(this._getHelpOption().long);
      }
      this.emit("afterHelp", eventContext);
      this._getCommandAndAncestors().forEach((command) => command.emit("afterAllHelp", eventContext));
    }
    helpOption(flags, description) {
      if (typeof flags === "boolean") {
        if (flags) {
          if (this._helpOption === null)
            this._helpOption = undefined;
          if (this._defaultOptionGroup) {
            this._initOptionGroup(this._getHelpOption());
          }
        } else {
          this._helpOption = null;
        }
        return this;
      }
      this._helpOption = this.createOption(flags ?? "-h, --help", description ?? "display help for command");
      if (flags || description)
        this._initOptionGroup(this._helpOption);
      return this;
    }
    _getHelpOption() {
      if (this._helpOption === undefined) {
        this.helpOption(undefined, undefined);
      }
      return this._helpOption;
    }
    addHelpOption(option) {
      this._helpOption = option;
      this._initOptionGroup(option);
      return this;
    }
    help(contextOptions) {
      this.outputHelp(contextOptions);
      let exitCode = Number(process2.exitCode ?? 0);
      if (exitCode === 0 && contextOptions && typeof contextOptions !== "function" && contextOptions.error) {
        exitCode = 1;
      }
      this._exit(exitCode, "commander.help", "(outputHelp)");
    }
    addHelpText(position, text) {
      const allowedValues = ["beforeAll", "before", "after", "afterAll"];
      if (!allowedValues.includes(position)) {
        throw new Error(`Unexpected value for position to addHelpText.
Expecting one of '${allowedValues.join("', '")}'`);
      }
      const helpEvent = `${position}Help`;
      this.on(helpEvent, (context) => {
        let helpStr;
        if (typeof text === "function") {
          helpStr = text({ error: context.error, command: context.command });
        } else {
          helpStr = text;
        }
        if (helpStr) {
          context.write(`${helpStr}
`);
        }
      });
      return this;
    }
    _outputHelpIfRequested(args) {
      const helpOption = this._getHelpOption();
      const helpRequested = helpOption && args.find((arg) => helpOption.is(arg));
      if (helpRequested) {
        this.outputHelp();
        this._exit(0, "commander.helpDisplayed", "(outputHelp)");
      }
    }
  }
  function incrementNodeInspectorPort(args) {
    return args.map((arg) => {
      if (!arg.startsWith("--inspect")) {
        return arg;
      }
      let debugOption;
      let debugHost = "127.0.0.1";
      let debugPort = "9229";
      let match;
      if ((match = arg.match(/^(--inspect(-brk)?)$/)) !== null) {
        debugOption = match[1];
      } else if ((match = arg.match(/^(--inspect(-brk|-port)?)=([^:]+)$/)) !== null) {
        debugOption = match[1];
        if (/^\d+$/.test(match[3])) {
          debugPort = match[3];
        } else {
          debugHost = match[3];
        }
      } else if ((match = arg.match(/^(--inspect(-brk|-port)?)=([^:]+):(\d+)$/)) !== null) {
        debugOption = match[1];
        debugHost = match[3];
        debugPort = match[4];
      }
      if (debugOption && debugPort !== "0") {
        return `${debugOption}=${debugHost}:${parseInt(debugPort) + 1}`;
      }
      return arg;
    });
  }
  function useColor() {
    if (process2.env.NO_COLOR || process2.env.FORCE_COLOR === "0" || process2.env.FORCE_COLOR === "false")
      return false;
    if (process2.env.FORCE_COLOR || process2.env.CLICOLOR_FORCE !== undefined)
      return true;
    return;
  }
  exports.Command = Command;
  exports.useColor = useColor;
});

// node_modules/commander/index.js
var require_commander = __commonJS((exports) => {
  var { Argument } = require_argument();
  var { Command } = require_command();
  var { CommanderError, InvalidArgumentError } = require_error();
  var { Help } = require_help();
  var { Option } = require_option();
  exports.program = new Command;
  exports.createCommand = (name) => new Command(name);
  exports.createOption = (flags, description) => new Option(flags, description);
  exports.createArgument = (name, description) => new Argument(name, description);
  exports.Command = Command;
  exports.Option = Option;
  exports.Argument = Argument;
  exports.Help = Help;
  exports.CommanderError = CommanderError;
  exports.InvalidArgumentError = InvalidArgumentError;
  exports.InvalidOptionArgumentError = InvalidArgumentError;
});

// node_modules/sisteransi/src/index.js
var require_src = __commonJS((exports, module) => {
  var ESC2 = "\x1B";
  var CSI2 = `${ESC2}[`;
  var beep = "\x07";
  var cursor = {
    to(x, y) {
      if (!y)
        return `${CSI2}${x + 1}G`;
      return `${CSI2}${y + 1};${x + 1}H`;
    },
    move(x, y) {
      let ret = "";
      if (x < 0)
        ret += `${CSI2}${-x}D`;
      else if (x > 0)
        ret += `${CSI2}${x}C`;
      if (y < 0)
        ret += `${CSI2}${-y}A`;
      else if (y > 0)
        ret += `${CSI2}${y}B`;
      return ret;
    },
    up: (count = 1) => `${CSI2}${count}A`,
    down: (count = 1) => `${CSI2}${count}B`,
    forward: (count = 1) => `${CSI2}${count}C`,
    backward: (count = 1) => `${CSI2}${count}D`,
    nextLine: (count = 1) => `${CSI2}E`.repeat(count),
    prevLine: (count = 1) => `${CSI2}F`.repeat(count),
    left: `${CSI2}G`,
    hide: `${CSI2}?25l`,
    show: `${CSI2}?25h`,
    save: `${ESC2}7`,
    restore: `${ESC2}8`
  };
  var scroll = {
    up: (count = 1) => `${CSI2}S`.repeat(count),
    down: (count = 1) => `${CSI2}T`.repeat(count)
  };
  var erase = {
    screen: `${CSI2}2J`,
    up: (count = 1) => `${CSI2}1J`.repeat(count),
    down: (count = 1) => `${CSI2}J`.repeat(count),
    line: `${CSI2}2K`,
    lineEnd: `${CSI2}K`,
    lineStart: `${CSI2}1K`,
    lines(count) {
      let clear = "";
      for (let i = 0;i < count; i++)
        clear += this.line + (i < count - 1 ? cursor.up() : "");
      if (count)
        clear += cursor.left;
      return clear;
    }
  };
  module.exports = { cursor, scroll, erase, beep };
});

// node_modules/commander/esm.mjs
var import__ = __toESM(require_commander(), 1);
var {
  program,
  createCommand,
  createArgument,
  createOption,
  CommanderError,
  InvalidArgumentError,
  InvalidOptionArgumentError,
  Command,
  Argument,
  Option,
  Help
} = import__.default;

// src/commands/hermes/types.ts
var SOUL_TONES = ["direct", "playful", "formal", "terse"];

// src/recipes/Recipe.ts
class Recipe {
  context;
  ingredients = [];
  constructor(context) {
    this.context = context;
  }
  addIngredient(CommandClass) {
    this.ingredients.push(new CommandClass(this.context));
    return this;
  }
  async execute() {
    const dryRunPrefix = this.context.dryRun ? "[DRY RUN] " : "";
    console.log(`${dryRunPrefix}\uD83D\uDE80 Initializing ${this.constructor.name.replace("Recipe", "").toLowerCase()} subsystem...`);
    if (this.context.dryRun) {
      console.log("⚠️  Dry-run mode: No files will be modified");
      console.log("");
    }
    for (const command of this.ingredients) {
      const result = await command.invoke();
      if (result.success) {
        console.log(result.message);
      } else {
        console.log(result.message);
      }
    }
    if (!this.context.dryRun) {
      this.printNextSteps();
    } else {
      console.log("");
      console.log("✓ Dry-run complete - no files were modified");
      console.log("  Remove --dry-run flag to apply changes");
    }
  }
}

// src/commands/Command.ts
class Command2 {
  context;
  constructor(context) {
    this.context = context;
  }
  formatMessage(message) {
    return this.context.dryRun ? `[DRY RUN] ${message}` : message;
  }
  fileExists(filePath) {
    const { existsSync } = __require("fs");
    const { join } = __require("path");
    const fullPath = join(this.context.targetDir, filePath);
    return existsSync(fullPath);
  }
  writeFile(filePath, content) {
    if (this.context.dryRun) {
      return;
    }
    const { writeFileSync, mkdirSync } = __require("fs");
    const { join, dirname } = __require("path");
    const fullPath = join(this.context.targetDir, filePath);
    const dir = dirname(fullPath);
    mkdirSync(dir, { recursive: true });
    writeFileSync(fullPath, content);
  }
  createDirectory(dirPath) {
    if (this.context.dryRun) {
      return;
    }
    const { mkdirSync } = __require("fs");
    const { join } = __require("path");
    const fullPath = join(this.context.targetDir, dirPath);
    mkdirSync(fullPath, { recursive: true });
  }
}

// src/commands/AddMiseToml.ts
class AddMiseToml extends Command2 {
  async invoke() {
    const filePath = "mise.toml";
    if (this.fileExists(filePath) && !this.context.force) {
      return {
        success: false,
        message: this.formatMessage("⚠️  mise.toml already exists"),
        filePath
      };
    }
    const content = `# Mise configuration
[tools]
python = "3.11"
node = "20"

[env]
NODE_ENV = "development"
`;
    this.writeFile(filePath, content);
    return {
      success: true,
      message: this.formatMessage(this.context.dryRun ? "Would create mise.toml" : "✅ Created mise.toml"),
      filePath
    };
  }
}

// src/commands/AddDotenv.ts
class AddDotenv extends Command2 {
  async invoke() {
    const filePath = ".env";
    if (this.fileExists(filePath) && !this.context.force) {
      return {
        success: false,
        message: this.formatMessage("⚠️  .env already exists"),
        filePath
      };
    }
    const content = `# Environment variables
DATABASE_URL=""
API_KEY=""
SECRET_KEY=""
`;
    this.writeFile(filePath, content);
    return {
      success: true,
      message: this.formatMessage(this.context.dryRun ? "Would create .env" : "✅ Created .env"),
      filePath
    };
  }
}

// src/commands/AddMiseTasksStructure.ts
class AddMiseTasksStructure extends Command2 {
  async invoke() {
    this.createDirectory(".mise/tasks/scripts");
    return {
      success: true,
      message: this.formatMessage(this.context.dryRun ? "Would create .mise directory structure" : "✅ Created .mise directory structure"),
      filePath: ".mise/tasks/scripts"
    };
  }
}

// src/commands/AddMiseBaseToml.ts
class AddMiseBaseToml extends Command2 {
  async invoke() {
    const filePath = ".mise/tasks/base.toml";
    if (this.fileExists(filePath) && !this.context.force) {
      return {
        success: false,
        message: this.formatMessage("⚠️  .mise/tasks/base.toml already exists"),
        filePath
      };
    }
    const content = `# Base tasks configuration
[tasks.setup]
run = "python scripts/base.py"
description = "Setup base environment"

[tasks.clean]
run = "rm -rf node_modules dist build"
description = "Clean build artifacts"

[tasks.dev]
run = "mise run setup"
description = "Initialize development environment"
`;
    this.writeFile(filePath, content);
    return {
      success: true,
      message: this.formatMessage(this.context.dryRun ? "Would create .mise/tasks/base.toml" : "✅ Created .mise/tasks/base.toml"),
      filePath
    };
  }
}

// src/commands/AddMiseBaseScript.ts
class AddMiseBaseScript extends Command2 {
  async invoke() {
    const filePath = ".mise/tasks/scripts/base.py";
    if (this.fileExists(filePath) && !this.context.force) {
      return {
        success: false,
        message: this.formatMessage("⚠️  .mise/tasks/scripts/base.py already exists"),
        filePath
      };
    }
    const content = `#!/usr/bin/env python3
"""Base setup script"""
import os
import sys
from pathlib import Path

def main():
    print("\uD83D\uDD27 Setting up base environment...")

    dirs_to_create = ["logs", "temp", "data"]
    for dir_name in dirs_to_create:
        Path(dir_name).mkdir(exist_ok=True)
        print(f"  Created {dir_name}/ directory")

    print("  Base environment setup complete!")
    print("  Run 'mise run dev' to start development")

if __name__ == "__main__":
    main()
`;
    this.writeFile(filePath, content);
    return {
      success: true,
      message: this.formatMessage(this.context.dryRun ? "Would create .mise/tasks/scripts/base.py" : "✅ Created .mise/tasks/scripts/base.py"),
      filePath
    };
  }
}

// src/recipes/MiseRecipe.ts
class MiseRecipe extends Recipe {
  constructor(context) {
    super(context);
    this.addIngredient(AddMiseToml).addIngredient(AddDotenv).addIngredient(AddMiseTasksStructure).addIngredient(AddMiseBaseToml).addIngredient(AddMiseBaseScript);
  }
  printNextSteps() {
    console.log("\uD83C\uDF89 Mise subsystem initialized successfully!");
    console.log("   Next steps:");
    console.log("   1. mise install");
    console.log("   2. mise run dev");
  }
}

// src/commands/AddDockerfile.ts
class AddDockerfile extends Command2 {
  async invoke() {
    const filePath = "Dockerfile";
    if (this.fileExists(filePath) && !this.context.force) {
      return {
        success: false,
        message: this.formatMessage("⚠️  Dockerfile already exists"),
        filePath
      };
    }
    const content = `FROM node:20-alpine

WORKDIR /app

COPY package.json bun.lockb ./
RUN bun install

COPY . .

RUN bun run build

EXPOSE 3000

CMD ["bun", "run", "start"]
`;
    this.writeFile(filePath, content);
    return {
      success: true,
      message: this.formatMessage(this.context.dryRun ? "Would create Dockerfile" : "✅ Created Dockerfile"),
      filePath
    };
  }
}

// src/commands/AddDockerCompose.ts
class AddDockerCompose extends Command2 {
  async invoke() {
    const filePath = "docker-compose.yml";
    if (this.fileExists(filePath) && !this.context.force) {
      return {
        success: false,
        message: this.formatMessage("⚠️  docker-compose.yml already exists"),
        filePath
      };
    }
    const content = `version: '3.8'

services:
  app:
    build: .
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=production
    volumes:
      - ./logs:/app/logs
    restart: unless-stopped

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    volumes:
      - redis_data:/data
    restart: unless-stopped

volumes:
  redis_data:
`;
    this.writeFile(filePath, content);
    return {
      success: true,
      message: this.formatMessage(this.context.dryRun ? "Would create docker-compose.yml" : "✅ Created docker-compose.yml"),
      filePath
    };
  }
}

// src/commands/AddDockerignore.ts
class AddDockerignore extends Command2 {
  async invoke() {
    const filePath = ".dockerignore";
    if (this.fileExists(filePath) && !this.context.force) {
      return {
        success: false,
        message: this.formatMessage("⚠️  .dockerignore already exists"),
        filePath
      };
    }
    const content = `node_modules
npm-debug.log
dist
build
.env
.git
*.md
`;
    this.writeFile(filePath, content);
    return {
      success: true,
      message: this.formatMessage(this.context.dryRun ? "Would create .dockerignore" : "✅ Created .dockerignore"),
      filePath
    };
  }
}

// src/recipes/DockerRecipe.ts
class DockerRecipe extends Recipe {
  constructor(context) {
    super(context);
    this.addIngredient(AddDockerfile).addIngredient(AddDockerCompose).addIngredient(AddDockerignore);
  }
  printNextSteps() {
    console.log("\uD83C\uDF89 Docker subsystem initialized successfully!");
    console.log("   Next steps:");
    console.log("   1. docker-compose up -d");
    console.log("   2. docker-compose logs -f");
  }
}

// src/commands/NodeCommands.ts
class AddPackageJson extends Command2 {
  async invoke() {
    const filePath = "package.json";
    if (this.fileExists(filePath) && !this.context.force) {
      return {
        success: false,
        message: "⚠️  package.json already exists",
        filePath
      };
    }
    const content = `{
  "name": "my-project",
  "version": "1.0.0",
  "description": "A new project",
  "main": "index.js",
  "scripts": {
    "start": "node index.js",
    "dev": "node --watch index.js",
    "test": "echo \\"Error: no test specified\\" && exit 1"
  },
  "keywords": [],
  "author": "",
  "license": "ISC"
}
`;
    this.writeFile(filePath, content);
    return {
      success: true,
      message: "✅ Created package.json",
      filePath
    };
  }
}

class AddReadme extends Command2 {
  async invoke() {
    const filePath = "README.md";
    if (this.fileExists(filePath) && !this.context.force) {
      return {
        success: false,
        message: "⚠️  README.md already exists",
        filePath
      };
    }
    const content = `# My Project

A new project initialized with pjangler.

## Getting Started

1. Install dependencies: \`mise install\`
2. Start development: \`mise run dev\`

## Project Structure

- \`mise.toml\` - Environment configuration
- \`.mise/tasks/\` - Task definitions
- \`src/\` - Source code
`;
    this.writeFile(filePath, content);
    return {
      success: true,
      message: "✅ Created README.md",
      filePath
    };
  }
}

class AddSrcDirectory extends Command2 {
  async invoke() {
    this.createDirectory("src");
    const indexJsPath = "src/index.js";
    const content = `console.log("Hello, World!");
`;
    this.writeFile(indexJsPath, content);
    return {
      success: true,
      message: "✅ Created src/ directory with index.js",
      filePath: "src/index.js"
    };
  }
}

// src/recipes/NodeRecipe.ts
class NodeRecipe extends Recipe {
  constructor(context) {
    super(context);
    this.addIngredient(AddPackageJson).addIngredient(AddReadme).addIngredient(AddSrcDirectory);
  }
  printNextSteps() {
    console.log("\uD83C\uDF89 Node.js project initialized successfully!");
    console.log("   Next steps:");
    console.log("   1. mise install");
    console.log("   2. mise run dev");
  }
}

// src/commands/hermes/PromptForAgentConfig.ts
import { basename } from "node:path";

// node_modules/@clack/core/dist/index.mjs
import { styleText as v } from "node:util";
import { stdout as x, stdin as D } from "node:process";
import * as b from "node:readline";
import E from "node:readline";

// node_modules/fast-string-truncated-width/dist/utils.js
var getCodePointsLength = (() => {
  const SURROGATE_PAIR_RE = /[\uD800-\uDBFF][\uDC00-\uDFFF]/g;
  return (input) => {
    let surrogatePairsNr = 0;
    SURROGATE_PAIR_RE.lastIndex = 0;
    while (SURROGATE_PAIR_RE.test(input)) {
      surrogatePairsNr += 1;
    }
    return input.length - surrogatePairsNr;
  };
})();
var isFullWidth = (x) => {
  return x === 12288 || x >= 65281 && x <= 65376 || x >= 65504 && x <= 65510;
};
var isWideNotCJKTNotEmoji = (x) => {
  return x === 8987 || x === 9001 || x >= 12272 && x <= 12287 || x >= 12289 && x <= 12350 || x >= 12441 && x <= 12543 || x >= 12549 && x <= 12591 || x >= 12593 && x <= 12686 || x >= 12688 && x <= 12771 || x >= 12783 && x <= 12830 || x >= 12832 && x <= 12871 || x >= 12880 && x <= 19903 || x >= 65040 && x <= 65049 || x >= 65072 && x <= 65106 || x >= 65108 && x <= 65126 || x >= 65128 && x <= 65131 || x >= 127488 && x <= 127490 || x >= 127504 && x <= 127547 || x >= 127552 && x <= 127560 || x >= 131072 && x <= 196605 || x >= 196608 && x <= 262141;
};

// node_modules/fast-string-truncated-width/dist/index.js
var ANSI_RE = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]|\u001b\]8;[^;]*;.*?(?:\u0007|\u001b\u005c)/y;
var CONTROL_RE = /[\x00-\x08\x0A-\x1F\x7F-\x9F]{1,1000}/y;
var CJKT_WIDE_RE = /(?:(?![\uFF61-\uFF9F\uFF00-\uFFEF])[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Tangut}]){1,1000}/yu;
var TAB_RE = /\t{1,1000}/y;
var EMOJI_RE = /[\u{1F1E6}-\u{1F1FF}]{2}|\u{1F3F4}[\u{E0061}-\u{E007A}]{2}[\u{E0030}-\u{E0039}\u{E0061}-\u{E007A}]{1,3}\u{E007F}|(?:\p{Emoji}\uFE0F\u20E3?|\p{Emoji_Modifier_Base}\p{Emoji_Modifier}?|\p{Emoji_Presentation})(?:\u200D(?:\p{Emoji_Modifier_Base}\p{Emoji_Modifier}?|\p{Emoji_Presentation}|\p{Emoji}\uFE0F\u20E3?))*/yu;
var LATIN_RE = /(?:[\x20-\x7E\xA0-\xFF](?!\uFE0F)){1,1000}/y;
var MODIFIER_RE = /\p{M}+/gu;
var NO_TRUNCATION = { limit: Infinity, ellipsis: "" };
var getStringTruncatedWidth = (input, truncationOptions = {}, widthOptions = {}) => {
  const LIMIT = truncationOptions.limit ?? Infinity;
  const ELLIPSIS = truncationOptions.ellipsis ?? "";
  const ELLIPSIS_WIDTH = truncationOptions?.ellipsisWidth ?? (ELLIPSIS ? getStringTruncatedWidth(ELLIPSIS, NO_TRUNCATION, widthOptions).width : 0);
  const ANSI_WIDTH = 0;
  const CONTROL_WIDTH = widthOptions.controlWidth ?? 0;
  const TAB_WIDTH = widthOptions.tabWidth ?? 8;
  const EMOJI_WIDTH = widthOptions.emojiWidth ?? 2;
  const FULL_WIDTH_WIDTH = 2;
  const REGULAR_WIDTH = widthOptions.regularWidth ?? 1;
  const WIDE_WIDTH = widthOptions.wideWidth ?? FULL_WIDTH_WIDTH;
  const PARSE_BLOCKS = [
    [LATIN_RE, REGULAR_WIDTH],
    [ANSI_RE, ANSI_WIDTH],
    [CONTROL_RE, CONTROL_WIDTH],
    [TAB_RE, TAB_WIDTH],
    [EMOJI_RE, EMOJI_WIDTH],
    [CJKT_WIDE_RE, WIDE_WIDTH]
  ];
  let indexPrev = 0;
  let index = 0;
  let length = input.length;
  let lengthExtra = 0;
  let truncationEnabled = false;
  let truncationIndex = length;
  let truncationLimit = Math.max(0, LIMIT - ELLIPSIS_WIDTH);
  let unmatchedStart = 0;
  let unmatchedEnd = 0;
  let width = 0;
  let widthExtra = 0;
  outer:
    while (true) {
      if (unmatchedEnd > unmatchedStart || index >= length && index > indexPrev) {
        const unmatched = input.slice(unmatchedStart, unmatchedEnd) || input.slice(indexPrev, index);
        lengthExtra = 0;
        for (const char of unmatched.replaceAll(MODIFIER_RE, "")) {
          const codePoint = char.codePointAt(0) || 0;
          if (isFullWidth(codePoint)) {
            widthExtra = FULL_WIDTH_WIDTH;
          } else if (isWideNotCJKTNotEmoji(codePoint)) {
            widthExtra = WIDE_WIDTH;
          } else {
            widthExtra = REGULAR_WIDTH;
          }
          if (width + widthExtra > truncationLimit) {
            truncationIndex = Math.min(truncationIndex, Math.max(unmatchedStart, indexPrev) + lengthExtra);
          }
          if (width + widthExtra > LIMIT) {
            truncationEnabled = true;
            break outer;
          }
          lengthExtra += char.length;
          width += widthExtra;
        }
        unmatchedStart = unmatchedEnd = 0;
      }
      if (index >= length) {
        break outer;
      }
      for (let i = 0, l = PARSE_BLOCKS.length;i < l; i++) {
        const [BLOCK_RE, BLOCK_WIDTH] = PARSE_BLOCKS[i];
        BLOCK_RE.lastIndex = index;
        if (BLOCK_RE.test(input)) {
          lengthExtra = BLOCK_RE === CJKT_WIDE_RE ? getCodePointsLength(input.slice(index, BLOCK_RE.lastIndex)) : BLOCK_RE === EMOJI_RE ? 1 : BLOCK_RE.lastIndex - index;
          widthExtra = lengthExtra * BLOCK_WIDTH;
          if (width + widthExtra > truncationLimit) {
            truncationIndex = Math.min(truncationIndex, index + Math.floor((truncationLimit - width) / BLOCK_WIDTH));
          }
          if (width + widthExtra > LIMIT) {
            truncationEnabled = true;
            break outer;
          }
          width += widthExtra;
          unmatchedStart = indexPrev;
          unmatchedEnd = index;
          index = indexPrev = BLOCK_RE.lastIndex;
          continue outer;
        }
      }
      index += 1;
    }
  return {
    width: truncationEnabled ? truncationLimit : width,
    index: truncationEnabled ? truncationIndex : length,
    truncated: truncationEnabled,
    ellipsed: truncationEnabled && LIMIT >= ELLIPSIS_WIDTH
  };
};
var dist_default = getStringTruncatedWidth;

// node_modules/fast-string-width/dist/index.js
var NO_TRUNCATION2 = {
  limit: Infinity,
  ellipsis: "",
  ellipsisWidth: 0
};
var fastStringWidth = (input, options = {}) => {
  return dist_default(input, NO_TRUNCATION2, options).width;
};
var dist_default2 = fastStringWidth;

// node_modules/fast-wrap-ansi/lib/main.js
var ESC = "\x1B";
var CSI = "";
var END_CODE = 39;
var ANSI_ESCAPE_BELL = "\x07";
var ANSI_CSI = "[";
var ANSI_OSC = "]";
var ANSI_SGR_TERMINATOR = "m";
var ANSI_ESCAPE_LINK = `${ANSI_OSC}8;;`;
var GROUP_REGEX = new RegExp(`(?:\\${ANSI_CSI}(?<code>\\d+)m|\\${ANSI_ESCAPE_LINK}(?<uri>.*)${ANSI_ESCAPE_BELL})`, "y");
var getClosingCode = (openingCode) => {
  if (openingCode >= 30 && openingCode <= 37)
    return 39;
  if (openingCode >= 90 && openingCode <= 97)
    return 39;
  if (openingCode >= 40 && openingCode <= 47)
    return 49;
  if (openingCode >= 100 && openingCode <= 107)
    return 49;
  if (openingCode === 1 || openingCode === 2)
    return 22;
  if (openingCode === 3)
    return 23;
  if (openingCode === 4)
    return 24;
  if (openingCode === 7)
    return 27;
  if (openingCode === 8)
    return 28;
  if (openingCode === 9)
    return 29;
  if (openingCode === 0)
    return 0;
  return;
};
var wrapAnsiCode = (code) => `${ESC}${ANSI_CSI}${code}${ANSI_SGR_TERMINATOR}`;
var wrapAnsiHyperlink = (url) => `${ESC}${ANSI_ESCAPE_LINK}${url}${ANSI_ESCAPE_BELL}`;
var wrapWord = (rows, word, columns) => {
  const characters = word[Symbol.iterator]();
  let isInsideEscape = false;
  let isInsideLinkEscape = false;
  let lastRow = rows.at(-1);
  let visible = lastRow === undefined ? 0 : dist_default2(lastRow);
  let currentCharacter = characters.next();
  let nextCharacter = characters.next();
  let rawCharacterIndex = 0;
  while (!currentCharacter.done) {
    const character = currentCharacter.value;
    const characterLength = dist_default2(character);
    if (visible + characterLength <= columns) {
      rows[rows.length - 1] += character;
    } else {
      rows.push(character);
      visible = 0;
    }
    if (character === ESC || character === CSI) {
      isInsideEscape = true;
      isInsideLinkEscape = word.startsWith(ANSI_ESCAPE_LINK, rawCharacterIndex + 1);
    }
    if (isInsideEscape) {
      if (isInsideLinkEscape) {
        if (character === ANSI_ESCAPE_BELL) {
          isInsideEscape = false;
          isInsideLinkEscape = false;
        }
      } else if (character === ANSI_SGR_TERMINATOR) {
        isInsideEscape = false;
      }
    } else {
      visible += characterLength;
      if (visible === columns && !nextCharacter.done) {
        rows.push("");
        visible = 0;
      }
    }
    currentCharacter = nextCharacter;
    nextCharacter = characters.next();
    rawCharacterIndex += character.length;
  }
  lastRow = rows.at(-1);
  if (!visible && lastRow !== undefined && lastRow.length && rows.length > 1) {
    rows[rows.length - 2] += rows.pop();
  }
};
var stringVisibleTrimSpacesRight = (string) => {
  const words = string.split(" ");
  let last = words.length;
  while (last) {
    if (dist_default2(words[last - 1])) {
      break;
    }
    last--;
  }
  if (last === words.length) {
    return string;
  }
  return words.slice(0, last).join(" ") + words.slice(last).join("");
};
var exec = (string, columns, options = {}) => {
  if (options.trim !== false && string.trim() === "") {
    return "";
  }
  let returnValue = "";
  let escapeCode;
  let escapeUrl;
  const words = string.split(" ");
  let rows = [""];
  let rowLength = 0;
  for (let index = 0;index < words.length; index++) {
    const word = words[index];
    if (options.trim !== false) {
      const row = rows.at(-1) ?? "";
      const trimmed = row.trimStart();
      if (row.length !== trimmed.length) {
        rows[rows.length - 1] = trimmed;
        rowLength = dist_default2(trimmed);
      }
    }
    if (index !== 0) {
      if (rowLength >= columns && (options.wordWrap === false || options.trim === false)) {
        rows.push("");
        rowLength = 0;
      }
      if (rowLength || options.trim === false) {
        rows[rows.length - 1] += " ";
        rowLength++;
      }
    }
    const wordLength = dist_default2(word);
    if (options.hard && wordLength > columns) {
      const remainingColumns = columns - rowLength;
      const breaksStartingThisLine = 1 + Math.floor((wordLength - remainingColumns - 1) / columns);
      const breaksStartingNextLine = Math.floor((wordLength - 1) / columns);
      if (breaksStartingNextLine < breaksStartingThisLine) {
        rows.push("");
      }
      wrapWord(rows, word, columns);
      rowLength = dist_default2(rows.at(-1) ?? "");
      continue;
    }
    if (rowLength + wordLength > columns && rowLength && wordLength) {
      if (options.wordWrap === false && rowLength < columns) {
        wrapWord(rows, word, columns);
        rowLength = dist_default2(rows.at(-1) ?? "");
        continue;
      }
      rows.push("");
      rowLength = 0;
    }
    if (rowLength + wordLength > columns && options.wordWrap === false) {
      wrapWord(rows, word, columns);
      rowLength = dist_default2(rows.at(-1) ?? "");
      continue;
    }
    rows[rows.length - 1] += word;
    rowLength += wordLength;
  }
  if (options.trim !== false) {
    rows = rows.map((row) => stringVisibleTrimSpacesRight(row));
  }
  const preString = rows.join(`
`);
  let inSurrogate = false;
  for (let i = 0;i < preString.length; i++) {
    const character = preString[i];
    returnValue += character;
    if (!inSurrogate) {
      inSurrogate = character >= "\uD800" && character <= "\uDBFF";
      if (inSurrogate) {
        continue;
      }
    } else {
      inSurrogate = false;
    }
    if (character === ESC || character === CSI) {
      GROUP_REGEX.lastIndex = i + 1;
      const groupsResult = GROUP_REGEX.exec(preString);
      const groups = groupsResult?.groups;
      if (groups?.code !== undefined) {
        const code = Number.parseFloat(groups.code);
        escapeCode = code === END_CODE ? undefined : code;
      } else if (groups?.uri !== undefined) {
        escapeUrl = groups.uri.length === 0 ? undefined : groups.uri;
      }
    }
    if (preString[i + 1] === `
`) {
      if (escapeUrl) {
        returnValue += wrapAnsiHyperlink("");
      }
      const closingCode = escapeCode ? getClosingCode(escapeCode) : undefined;
      if (escapeCode && closingCode) {
        returnValue += wrapAnsiCode(closingCode);
      }
    } else if (character === `
`) {
      if (escapeCode && getClosingCode(escapeCode)) {
        returnValue += wrapAnsiCode(escapeCode);
      }
      if (escapeUrl) {
        returnValue += wrapAnsiHyperlink(escapeUrl);
      }
    }
  }
  return returnValue;
};
var CRLF_OR_LF = /\r?\n/;
function wrapAnsi(string, columns, options) {
  return String(string).normalize().split(CRLF_OR_LF).map((line) => exec(line, columns, options)).join(`
`);
}

// node_modules/@clack/core/dist/index.mjs
var import_sisteransi = __toESM(require_src(), 1);
import { ReadStream as O } from "node:tty";
function f(r, t, s) {
  if (!s.some((o) => !o.disabled))
    return r;
  const e = r + t, i = Math.max(s.length - 1, 0), n = e < 0 ? i : e > i ? 0 : e;
  return s[n].disabled ? f(n, t < 0 ? -1 : 1, s) : n;
}
function I(r, t, s, e) {
  const i = e.split(`
`);
  let n = 0, o = r;
  for (const a of i) {
    if (o <= a.length)
      break;
    o -= a.length + 1, n++;
  }
  for (n = Math.max(0, Math.min(i.length - 1, n + s)), o = Math.min(o, i[n].length) + t;o < 0 && n > 0; )
    n--, o += i[n].length + 1;
  for (;o > i[n].length && n < i.length - 1; )
    o -= i[n].length + 1, n++;
  o = Math.max(0, Math.min(i[n].length, o));
  let u = 0;
  for (let a = 0;a < n; a++)
    u += i[a].length + 1;
  return u + o;
}
var G = ["up", "down", "left", "right", "space", "enter", "cancel"];
var K = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
var h = { actions: new Set(G), aliases: new Map([["k", "up"], ["j", "down"], ["h", "left"], ["l", "right"], ["\x03", "cancel"], ["escape", "cancel"]]), messages: { cancel: "Canceled", error: "Something went wrong" }, withGuide: true, date: { monthNames: [...K], messages: { required: "Please enter a valid date", invalidMonth: "There are only 12 months in a year", invalidDay: (r, t) => `There are only ${r} days in ${t}`, afterMin: (r) => `Date must be on or after ${r.toISOString().slice(0, 10)}`, beforeMax: (r) => `Date must be on or before ${r.toISOString().slice(0, 10)}` } } };
function C(r, t) {
  if (typeof r == "string")
    return h.aliases.get(r) === t;
  for (const s of r)
    if (s !== undefined && C(s, t))
      return true;
  return false;
}
function z(r, t) {
  if (r === t)
    return;
  const s = r.split(`
`), e = t.split(`
`), i = Math.max(s.length, e.length), n = [];
  for (let o = 0;o < i; o++)
    s[o] !== e[o] && n.push(o);
  return { lines: n, numLinesBefore: s.length, numLinesAfter: e.length, numLines: i };
}
var Y = globalThis.process.platform.startsWith("win");
var k = Symbol("clack:cancel");
function q(r) {
  return r === k;
}
function w(r, t) {
  const s = r;
  s.isTTY && s.setRawMode(t);
}
function R({ input: r = D, output: t = x, overwrite: s = true, hideCursor: e = true } = {}) {
  const i = b.createInterface({ input: r, output: t, prompt: "", tabSize: 1 });
  b.emitKeypressEvents(r, i), r instanceof O && r.isTTY && r.setRawMode(true);
  const n = (o, { name: u, sequence: a }) => {
    const l = String(o);
    if (C([l, u, a], "cancel")) {
      e && t.write(import_sisteransi.cursor.show), process.exit(0);
      return;
    }
    if (!s)
      return;
    const c = u === "return" ? 0 : -1, y = u === "return" ? -1 : 0;
    b.moveCursor(t, c, y, () => {
      b.clearLine(t, 1, () => {
        r.once("keypress", n);
      });
    });
  };
  return e && t.write(import_sisteransi.cursor.hide), r.once("keypress", n), () => {
    r.off("keypress", n), e && t.write(import_sisteransi.cursor.show), r instanceof O && r.isTTY && !Y && r.setRawMode(false), i.terminal = false, i.close();
  };
}
var A = (r) => ("columns" in r) && typeof r.columns == "number" ? r.columns : 80;
var L = (r) => ("rows" in r) && typeof r.rows == "number" ? r.rows : 20;
function W(r, t, s, e = s, i = s, n) {
  const o = A(r ?? x);
  return wrapAnsi(t, o - s.length, { hard: true, trim: false }).split(`
`).map((u, a, l) => {
    const c = n ? n(u, a) : u;
    return a === 0 ? `${e}${c}` : a === l.length - 1 ? `${i}${c}` : `${s}${c}`;
  }).join(`
`);
}
var m = class {
  input;
  output;
  _abortSignal;
  rl;
  opts;
  _render;
  _track = false;
  _prevFrame = "";
  _subscribers = new Map;
  _cursor = 0;
  state = "initial";
  error = "";
  value;
  userInput = "";
  constructor(t, s = true) {
    const { input: e = D, output: i = x, render: n, signal: o, ...u } = t;
    this.opts = u, this.onKeypress = this.onKeypress.bind(this), this.close = this.close.bind(this), this.render = this.render.bind(this), this._render = n.bind(this), this._track = s, this._abortSignal = o, this.input = e, this.output = i;
  }
  unsubscribe() {
    this._subscribers.clear();
  }
  setSubscriber(t, s) {
    const e = this._subscribers.get(t) ?? [];
    e.push(s), this._subscribers.set(t, e);
  }
  on(t, s) {
    this.setSubscriber(t, { cb: s });
  }
  once(t, s) {
    this.setSubscriber(t, { cb: s, once: true });
  }
  emit(t, ...s) {
    const e = this._subscribers.get(t) ?? [], i = [];
    for (const n of e)
      n.cb(...s), n.once && i.push(() => e.splice(e.indexOf(n), 1));
    for (const n of i)
      n();
  }
  prompt() {
    return new Promise((t) => {
      if (this._abortSignal) {
        if (this._abortSignal.aborted)
          return this.state = "cancel", this.close(), t(k);
        this._abortSignal.addEventListener("abort", () => {
          this.state = "cancel", this.close();
        }, { once: true });
      }
      this.rl = E.createInterface({ input: this.input, tabSize: 2, prompt: "", escapeCodeTimeout: 50, terminal: true }), this.rl.prompt(), this.opts.initialUserInput !== undefined && this._setUserInput(this.opts.initialUserInput, true), this.input.on("keypress", this.onKeypress), w(this.input, true), this.output.on("resize", this.render), this.render(), this.once("submit", () => {
        this.output.write(import_sisteransi.cursor.show), this.output.off("resize", this.render), w(this.input, false), t(this.value);
      }), this.once("cancel", () => {
        this.output.write(import_sisteransi.cursor.show), this.output.off("resize", this.render), w(this.input, false), t(k);
      });
    });
  }
  _isActionKey(t, s) {
    return t === "\t";
  }
  _shouldSubmit(t, s) {
    return true;
  }
  _setValue(t) {
    this.value = t, this.emit("value", this.value);
  }
  _setUserInput(t, s) {
    this.userInput = t ?? "", this.emit("userInput", this.userInput), s && this._track && this.rl && (this.rl.write(this.userInput), this._cursor = this.rl.cursor);
  }
  _clearUserInput() {
    this.rl?.write(null, { ctrl: true, name: "u" }), this._setUserInput("");
  }
  onKeypress(t, s) {
    if (this._track && s.name !== "return" && (s.name && this._isActionKey(t, s) && this.rl?.write(null, { ctrl: true, name: "h" }), this._cursor = this.rl?.cursor ?? 0, this._setUserInput(this.rl?.line)), this.state === "error" && (this.state = "active"), s?.name && (!this._track && h.aliases.has(s.name) && this.emit("cursor", h.aliases.get(s.name)), h.actions.has(s.name) && this.emit("cursor", s.name)), t && (t.toLowerCase() === "y" || t.toLowerCase() === "n") && this.emit("confirm", t.toLowerCase() === "y"), this.emit("key", t?.toLowerCase(), s), s?.name === "return" && this._shouldSubmit(t, s)) {
      if (this.opts.validate) {
        const e = this.opts.validate(this.value);
        e && (this.error = e instanceof Error ? e.message : e, this.state = "error", this.rl?.write(this.userInput));
      }
      this.state !== "error" && (this.state = "submit");
    }
    C([t, s?.name, s?.sequence], "cancel") && (this.state = "cancel"), (this.state === "submit" || this.state === "cancel") && this.emit("finalize"), this.render(), (this.state === "submit" || this.state === "cancel") && this.close();
  }
  close() {
    this.input.unpipe(), this.input.removeListener("keypress", this.onKeypress), this.output.write(`
`), w(this.input, false), this.rl?.close(), this.rl = undefined, this.emit(`${this.state}`, this.value), this.unsubscribe();
  }
  restoreCursor() {
    const t = wrapAnsi(this._prevFrame, process.stdout.columns, { hard: true, trim: false }).split(`
`).length - 1;
    this.output.write(import_sisteransi.cursor.move(-999, t * -1));
  }
  render() {
    const t = wrapAnsi(this._render(this) ?? "", process.stdout.columns, { hard: true, trim: false });
    if (t !== this._prevFrame) {
      if (this.state === "initial")
        this.output.write(import_sisteransi.cursor.hide);
      else {
        const s = z(this._prevFrame, t), e = L(this.output);
        if (this.restoreCursor(), s) {
          const i = Math.max(0, s.numLinesAfter - e), n = Math.max(0, s.numLinesBefore - e);
          let o = s.lines.find((u) => u >= i);
          if (o === undefined) {
            this._prevFrame = t;
            return;
          }
          if (s.lines.length === 1) {
            this.output.write(import_sisteransi.cursor.move(0, o - n)), this.output.write(import_sisteransi.erase.lines(1));
            const u = t.split(`
`);
            this.output.write(u[o]), this._prevFrame = t, this.output.write(import_sisteransi.cursor.move(0, u.length - o - 1));
            return;
          } else if (s.lines.length > 1) {
            if (i < n)
              o = i;
            else {
              const a = o - n;
              a > 0 && this.output.write(import_sisteransi.cursor.move(0, a));
            }
            this.output.write(import_sisteransi.erase.down());
            const u = t.split(`
`).slice(o);
            this.output.write(u.join(`
`)), this._prevFrame = t;
            return;
          }
        }
        this.output.write(import_sisteransi.erase.down());
      }
      this.output.write(t), this.state === "initial" && (this.state = "active"), this._prevFrame = t;
    }
  }
};
function B(r, t) {
  if (r === undefined || t.length === 0)
    return 0;
  const s = t.findIndex((e) => e.value === r);
  return s !== -1 ? s : 0;
}
function J(r, t) {
  return (t.label ?? String(t.value)).toLowerCase().includes(r.toLowerCase());
}
function H(r, t) {
  if (t)
    return r ? t : t[0];
}
var Q = class extends m {
  filteredOptions;
  multiple;
  isNavigating = false;
  selectedValues = [];
  focusedValue;
  #s = 0;
  #r = "";
  #t;
  #n;
  #u;
  get cursor() {
    return this.#s;
  }
  get userInputWithCursor() {
    if (!this.userInput)
      return v(["inverse", "hidden"], "_");
    if (this._cursor >= this.userInput.length)
      return `${this.userInput}█`;
    const t = this.userInput.slice(0, this._cursor), [s, ...e] = this.userInput.slice(this._cursor);
    return `${t}${v("inverse", s)}${e.join("")}`;
  }
  get options() {
    return typeof this.#n == "function" ? this.#n() : this.#n;
  }
  constructor(t) {
    super(t), this.#n = t.options, this.#u = t.placeholder;
    const s = this.options;
    this.filteredOptions = [...s], this.multiple = t.multiple === true, this.#t = typeof t.options == "function" ? t.filter : t.filter ?? J;
    let e;
    if (t.initialValue && Array.isArray(t.initialValue) ? this.multiple ? e = t.initialValue : e = t.initialValue.slice(0, 1) : !this.multiple && this.options.length > 0 && (e = [this.options[0].value]), e)
      for (const i of e) {
        const n = s.findIndex((o) => o.value === i);
        n !== -1 && (this.toggleSelected(i), this.#s = n);
      }
    this.focusedValue = this.options[this.#s]?.value, this.on("key", (i, n) => this.#e(i, n)), this.on("userInput", (i) => this.#i(i));
  }
  _isActionKey(t, s) {
    return t === "\t" || this.multiple && this.isNavigating && s.name === "space" && t !== undefined && t !== "";
  }
  #e(t, s) {
    const e = s.name === "up", i = s.name === "down", n = s.name === "return", o = this.userInput === "" || this.userInput === "\t", u = this.#u, a = this.options, l = u !== undefined && u !== "" && a.some((c) => !c.disabled && (this.#t ? this.#t(u, c) : true));
    if (s.name === "tab" && o && l) {
      this.userInput === "\t" && this._clearUserInput(), this._setUserInput(u, true), this.isNavigating = false;
      return;
    }
    e || i ? (this.#s = f(this.#s, e ? -1 : 1, this.filteredOptions), this.focusedValue = this.filteredOptions[this.#s]?.value, this.multiple || (this.selectedValues = [this.focusedValue]), this.isNavigating = true) : n ? this.value = H(this.multiple, this.selectedValues) : this.multiple ? this.focusedValue !== undefined && (s.name === "tab" || this.isNavigating && s.name === "space") ? this.toggleSelected(this.focusedValue) : this.isNavigating = false : (this.focusedValue && (this.selectedValues = [this.focusedValue]), this.isNavigating = false);
  }
  deselectAll() {
    this.selectedValues = [];
  }
  toggleSelected(t) {
    this.filteredOptions.length !== 0 && (this.multiple ? this.selectedValues.includes(t) ? this.selectedValues = this.selectedValues.filter((s) => s !== t) : this.selectedValues = [...this.selectedValues, t] : this.selectedValues = [t]);
  }
  #i(t) {
    if (t !== this.#r) {
      this.#r = t;
      const s = this.options;
      t && this.#t ? this.filteredOptions = s.filter((n) => this.#t?.(t, n)) : this.filteredOptions = [...s];
      const e = B(this.focusedValue, this.filteredOptions);
      this.#s = f(e, 0, this.filteredOptions);
      const i = this.filteredOptions[this.#s];
      i && !i.disabled ? this.focusedValue = i.value : this.focusedValue = undefined, this.multiple || (this.focusedValue !== undefined ? this.toggleSelected(this.focusedValue) : this.deselectAll());
    }
  }
};

class X extends m {
  get cursor() {
    return this.value ? 0 : 1;
  }
  get _value() {
    return this.cursor === 0;
  }
  constructor(t) {
    super(t, false), this.value = !!t.initialValue, this.on("userInput", () => {
      this.value = this._value;
    }), this.on("confirm", (s) => {
      this.output.write(import_sisteransi.cursor.move(0, -1)), this.value = s, this.state = "submit", this.close();
    }), this.on("cursor", () => {
      this.value = !this.value;
    });
  }
}
var Z = { Y: { type: "year", len: 4 }, M: { type: "month", len: 2 }, D: { type: "day", len: 2 } };
function P(r) {
  return [...r].map((t) => Z[t]);
}
function tt(r) {
  const t = new Intl.DateTimeFormat(r, { year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(2000, 0, 15)), s = [];
  let e = "/";
  for (const i of t)
    i.type === "literal" ? e = i.value.trim() || i.value : (i.type === "year" || i.type === "month" || i.type === "day") && s.push({ type: i.type, len: i.type === "year" ? 4 : 2 });
  return { segments: s, separator: e };
}
function $(r) {
  return Number.parseInt((r || "0").replace(/_/g, "0"), 10) || 0;
}
function S(r) {
  return { year: $(r.year), month: $(r.month), day: $(r.day) };
}
function U(r, t) {
  return new Date(r || 2001, t || 1, 0).getDate();
}
function F(r) {
  const { year: t, month: s, day: e } = S(r);
  if (!t || t < 0 || t > 9999 || !s || s < 1 || s > 12 || !e || e < 1)
    return;
  const i = new Date(Date.UTC(t, s - 1, e));
  if (!(i.getUTCFullYear() !== t || i.getUTCMonth() !== s - 1 || i.getUTCDate() !== e))
    return { year: t, month: s, day: e };
}
function N(r) {
  const t = F(r);
  return t ? new Date(Date.UTC(t.year, t.month - 1, t.day)) : undefined;
}
function st(r, t, s, e) {
  const i = s ? { year: s.getUTCFullYear(), month: s.getUTCMonth() + 1, day: s.getUTCDate() } : null, n = e ? { year: e.getUTCFullYear(), month: e.getUTCMonth() + 1, day: e.getUTCDate() } : null;
  return r === "year" ? { min: i?.year ?? 1, max: n?.year ?? 9999 } : r === "month" ? { min: i && t.year === i.year ? i.month : 1, max: n && t.year === n.year ? n.month : 12 } : { min: i && t.year === i.year && t.month === i.month ? i.day : 1, max: n && t.year === n.year && t.month === n.month ? n.day : U(t.year, t.month) };
}

class et extends m {
  #s;
  #r;
  #t;
  #n;
  #u;
  #e = { segmentIndex: 0, positionInSegment: 0 };
  #i = true;
  #o = null;
  inlineError = "";
  get segmentCursor() {
    return { ...this.#e };
  }
  get segmentValues() {
    return { ...this.#t };
  }
  get segments() {
    return this.#s;
  }
  get separator() {
    return this.#r;
  }
  get formattedValue() {
    return this.#c(this.#t);
  }
  #c(t) {
    return this.#s.map((s) => t[s.type]).join(this.#r);
  }
  #a() {
    this._setUserInput(this.#c(this.#t)), this._setValue(N(this.#t) ?? undefined);
  }
  constructor(t) {
    const s = t.format ? { segments: P(t.format), separator: t.separator ?? "/" } : tt(t.locale), e = t.separator ?? s.separator, i = t.format ? P(t.format) : s.segments, n = t.initialValue ?? t.defaultValue, o = n ? { year: String(n.getUTCFullYear()).padStart(4, "0"), month: String(n.getUTCMonth() + 1).padStart(2, "0"), day: String(n.getUTCDate()).padStart(2, "0") } : { year: "____", month: "__", day: "__" }, u = i.map((a) => o[a.type]).join(e);
    super({ ...t, initialUserInput: u }, false), this.#s = i, this.#r = e, this.#t = o, this.#n = t.minDate, this.#u = t.maxDate, this.#a(), this.on("cursor", (a) => this.#d(a)), this.on("key", (a, l) => this.#f(a, l)), this.on("finalize", () => this.#g(t));
  }
  #h() {
    const t = Math.max(0, Math.min(this.#e.segmentIndex, this.#s.length - 1)), s = this.#s[t];
    if (s)
      return this.#e.positionInSegment = Math.max(0, Math.min(this.#e.positionInSegment, s.len - 1)), { segment: s, index: t };
  }
  #l(t) {
    this.inlineError = "", this.#o = null;
    const s = this.#h();
    s && (this.#e.segmentIndex = Math.max(0, Math.min(this.#s.length - 1, s.index + t)), this.#e.positionInSegment = 0, this.#i = true);
  }
  #p(t) {
    const s = this.#h();
    if (!s)
      return;
    const { segment: e } = s, i = this.#t[e.type], n = !i || i.replace(/_/g, "") === "", o = Number.parseInt((i || "0").replace(/_/g, "0"), 10) || 0, u = st(e.type, S(this.#t), this.#n, this.#u);
    let a;
    n ? a = t === 1 ? u.min : u.max : a = Math.max(Math.min(u.max, o + t), u.min), this.#t = { ...this.#t, [e.type]: a.toString().padStart(e.len, "0") }, this.#i = true, this.#o = null, this.#a();
  }
  #d(t) {
    if (t)
      switch (t) {
        case "right":
          return this.#l(1);
        case "left":
          return this.#l(-1);
        case "up":
          return this.#p(1);
        case "down":
          return this.#p(-1);
      }
  }
  #f(t, s) {
    if (s?.name === "backspace" || s?.sequence === "" || s?.sequence === "\b" || t === "" || t === "\b") {
      this.inlineError = "";
      const e = this.#h();
      if (!e)
        return;
      if (!this.#t[e.segment.type].replace(/_/g, "")) {
        this.#l(-1);
        return;
      }
      this.#t[e.segment.type] = "_".repeat(e.segment.len), this.#i = true, this.#e.positionInSegment = 0, this.#a();
      return;
    }
    if (s?.name === "tab") {
      this.inlineError = "";
      const e = this.#h();
      if (!e)
        return;
      const i = s.shift ? -1 : 1, n = e.index + i;
      n >= 0 && n < this.#s.length && (this.#e.segmentIndex = n, this.#e.positionInSegment = 0, this.#i = true);
      return;
    }
    if (t && /^[0-9]$/.test(t)) {
      const e = this.#h();
      if (!e)
        return;
      const { segment: i } = e, n = !this.#t[i.type].replace(/_/g, "");
      if (this.#i && this.#o !== null && !n) {
        const d = this.#o + t, g = { ...this.#t, [i.type]: d }, _ = this.#m(g, i);
        if (_) {
          this.inlineError = _, this.#o = null, this.#i = false;
          return;
        }
        this.inlineError = "", this.#t[i.type] = d, this.#o = null, this.#i = false, this.#a(), e.index < this.#s.length - 1 && (this.#e.segmentIndex = e.index + 1, this.#e.positionInSegment = 0, this.#i = true);
        return;
      }
      this.#i && !n && (this.#t[i.type] = "_".repeat(i.len), this.#e.positionInSegment = 0), this.#i = false, this.#o = null;
      const o = this.#t[i.type], u = o.indexOf("_"), a = u >= 0 ? u : Math.min(this.#e.positionInSegment, i.len - 1);
      if (a < 0 || a >= i.len)
        return;
      let l = o.slice(0, a) + t + o.slice(a + 1), c = false;
      if (a === 0 && o === "__" && (i.type === "month" || i.type === "day")) {
        const d = Number.parseInt(t, 10);
        l = `0${t}`, c = d <= (i.type === "month" ? 1 : 2);
      }
      if (i.type === "year" && (l = (o.replace(/_/g, "") + t).padStart(i.len, "_")), !l.includes("_")) {
        const d = { ...this.#t, [i.type]: l }, g = this.#m(d, i);
        if (g) {
          this.inlineError = g;
          return;
        }
      }
      this.inlineError = "", this.#t[i.type] = l;
      const y = l.includes("_") ? undefined : F(this.#t);
      if (y) {
        const { year: d, month: g } = y, _ = U(d, g);
        this.#t = { year: String(Math.max(0, Math.min(9999, d))).padStart(4, "0"), month: String(Math.max(1, Math.min(12, g))).padStart(2, "0"), day: String(Math.max(1, Math.min(_, y.day))).padStart(2, "0") };
      }
      this.#a();
      const T = l.indexOf("_");
      c ? (this.#i = true, this.#o = t) : T >= 0 ? this.#e.positionInSegment = T : u >= 0 && e.index < this.#s.length - 1 ? (this.#e.segmentIndex = e.index + 1, this.#e.positionInSegment = 0, this.#i = true) : this.#e.positionInSegment = Math.min(a + 1, i.len - 1);
    }
  }
  #m(t, s) {
    const { month: e, day: i } = S(t);
    if (s.type === "month" && (e < 0 || e > 12))
      return h.date.messages.invalidMonth;
    if (s.type === "day" && (i < 0 || i > 31))
      return h.date.messages.invalidDay(31, "any month");
  }
  #g(t) {
    const { year: s, month: e, day: i } = S(this.#t);
    if (s && e && i) {
      const n = U(s, e);
      this.#t = { ...this.#t, day: String(Math.min(i, n)).padStart(2, "0") };
    }
    this.value = N(this.#t) ?? t.defaultValue ?? undefined;
  }
}

class it extends m {
  options;
  cursor = 0;
  #s;
  getGroupItems(t) {
    return this.options.filter((s) => s.group === t);
  }
  isGroupSelected(t) {
    const s = this.getGroupItems(t), e = this.value;
    return e === undefined ? false : s.every((i) => e.includes(i.value));
  }
  toggleValue() {
    const t = this.options[this.cursor];
    if (this.value === undefined && (this.value = []), t.group === true) {
      const s = t.value, e = this.getGroupItems(s);
      this.isGroupSelected(s) ? this.value = this.value.filter((i) => e.findIndex((n) => n.value === i) === -1) : this.value = [...this.value, ...e.map((i) => i.value)], this.value = Array.from(new Set(this.value));
    } else {
      const s = this.value.includes(t.value);
      this.value = s ? this.value.filter((e) => e !== t.value) : [...this.value, t.value];
    }
  }
  constructor(t) {
    super(t, false);
    const { options: s } = t;
    this.#s = t.selectableGroups !== false, this.options = Object.entries(s).flatMap(([e, i]) => [{ value: e, group: true, label: e }, ...i.map((n) => ({ ...n, group: e }))]), this.value = [...t.initialValues ?? []], this.cursor = Math.max(this.options.findIndex(({ value: e }) => e === t.cursorAt), this.#s ? 0 : 1), this.on("cursor", (e) => {
      switch (e) {
        case "left":
        case "up": {
          this.cursor = this.cursor === 0 ? this.options.length - 1 : this.cursor - 1;
          const i = this.options[this.cursor]?.group === true;
          !this.#s && i && (this.cursor = this.cursor === 0 ? this.options.length - 1 : this.cursor - 1);
          break;
        }
        case "down":
        case "right": {
          this.cursor = this.cursor === this.options.length - 1 ? 0 : this.cursor + 1;
          const i = this.options[this.cursor]?.group === true;
          !this.#s && i && (this.cursor = this.cursor === this.options.length - 1 ? 0 : this.cursor + 1);
          break;
        }
        case "space":
          this.toggleValue();
          break;
      }
    });
  }
}

class rt extends m {
  #s = false;
  #r;
  focused = "editor";
  get userInputWithCursor() {
    if (this.state === "submit")
      return this.userInput;
    const t = this.userInput;
    if (this.cursor >= t.length)
      return `${t}█`;
    const s = t.slice(0, this.cursor), e = t[this.cursor], i = t.slice(this.cursor + 1);
    return e === `
` ? `${s}█
${i}` : `${s}${v("inverse", e)}${i}`;
  }
  get cursor() {
    return this._cursor;
  }
  #t(t) {
    if (this.userInput.length === 0) {
      this._setUserInput(t);
      return;
    }
    this._setUserInput(this.userInput.slice(0, this.cursor) + t + this.userInput.slice(this.cursor));
  }
  #n(t) {
    const s = this.value ?? "";
    switch (t) {
      case "up":
        this._cursor = I(this._cursor, 0, -1, s);
        return;
      case "down":
        this._cursor = I(this._cursor, 0, 1, s);
        return;
      case "left":
        this._cursor = I(this._cursor, -1, 0, s);
        return;
      case "right":
        this._cursor = I(this._cursor, 1, 0, s);
        return;
    }
  }
  _shouldSubmit(t, s) {
    if (this.#r)
      return this.focused === "submit" ? true : (this.#t(`
`), this._cursor++, false);
    const e = this.#s;
    return this.#s = true, e ? (this.userInput[this.cursor - 1] === `
` && (this._setUserInput(this.userInput.slice(0, this.cursor - 1) + this.userInput.slice(this.cursor)), this._cursor--), true) : (this.#t(`
`), this._cursor++, false);
  }
  constructor(t) {
    super(t, false), this.#r = t.showSubmit ?? false, this.on("key", (s, e) => {
      if (e?.name && h.actions.has(e.name)) {
        this.#n(e.name);
        return;
      }
      if (s === "\t" && this.#r) {
        this.focused = this.focused === "editor" ? "submit" : "editor";
        return;
      }
      if (e?.name !== "return") {
        if (this.#s = false, e?.name === "backspace" && this.cursor > 0) {
          this._setUserInput(this.userInput.slice(0, this.cursor - 1) + this.userInput.slice(this.cursor)), this._cursor--;
          return;
        }
        if (e?.name === "delete" && this.cursor < this.userInput.length) {
          this._setUserInput(this.userInput.slice(0, this.cursor) + this.userInput.slice(this.cursor + 1));
          return;
        }
        s && (this.#r && this.focused === "submit" && (this.focused = "editor"), this.#t(s ?? ""), this._cursor++);
      }
    }), this.on("userInput", (s) => {
      this._setValue(s);
    }), this.on("finalize", () => {
      this.value || (this.value = t.defaultValue), this.value === undefined && (this.value = "");
    });
  }
}
class ot extends m {
  _mask = "•";
  get cursor() {
    return this._cursor;
  }
  get masked() {
    return this.userInput.replaceAll(/./g, this._mask);
  }
  get userInputWithCursor() {
    if (this.state === "submit" || this.state === "cancel")
      return this.masked;
    const t = this.userInput;
    if (this.cursor >= t.length)
      return `${this.masked}${v(["inverse", "hidden"], "_")}`;
    const s = this.masked, e = s.slice(0, this.cursor), i = s.slice(this.cursor);
    return `${e}${v("inverse", i[0])}${i.slice(1)}`;
  }
  clear() {
    this._clearUserInput();
  }
  constructor({ mask: t, ...s }) {
    super(s), this._mask = t ?? "•", this.on("userInput", (e) => {
      this._setValue(e);
    });
  }
}

class ut extends m {
  options;
  cursor = 0;
  get _selectedValue() {
    return this.options[this.cursor];
  }
  changeValue() {
    this.value = this._selectedValue.value;
  }
  constructor(t) {
    super(t, false), this.options = t.options;
    const s = this.options.findIndex(({ value: i }) => i === t.initialValue), e = s === -1 ? 0 : s;
    this.cursor = this.options[e].disabled ? f(e, 1, this.options) : e, this.changeValue(), this.on("cursor", (i) => {
      switch (i) {
        case "left":
        case "up":
          this.cursor = f(this.cursor, -1, this.options);
          break;
        case "down":
        case "right":
          this.cursor = f(this.cursor, 1, this.options);
          break;
      }
      this.changeValue();
    });
  }
}
class ht extends m {
  get userInputWithCursor() {
    if (this.state === "submit")
      return this.userInput;
    const t = this.userInput;
    if (this.cursor >= t.length)
      return `${this.userInput}█`;
    const s = t.slice(0, this.cursor), [e, ...i] = t.slice(this.cursor);
    return `${s}${v("inverse", e)}${i.join("")}`;
  }
  get cursor() {
    return this._cursor;
  }
  constructor(t) {
    super({ ...t, initialUserInput: t.initialUserInput ?? t.initialValue }), this.on("userInput", (s) => {
      this._setValue(s);
    }), this.on("finalize", () => {
      this.value || (this.value = t.defaultValue), this.value === undefined && (this.value = "");
    });
  }
}

// node_modules/@clack/prompts/dist/index.mjs
import { styleText as e, stripVTControlCharacters as nt2 } from "node:util";
import V2 from "node:process";
var import_sisteransi2 = __toESM(require_src(), 1);
function ee() {
  return V2.platform !== "win32" ? V2.env.TERM !== "linux" : !!V2.env.CI || !!V2.env.WT_SESSION || !!V2.env.TERMINUS_SUBLIME || V2.env.ConEmuTask === "{cmd::Cmder}" || V2.env.TERM_PROGRAM === "Terminus-Sublime" || V2.env.TERM_PROGRAM === "vscode" || V2.env.TERM === "xterm-256color" || V2.env.TERM === "alacritty" || V2.env.TERMINAL_EMULATOR === "JetBrains-JediTerm";
}
var tt2 = ee();
var ot2 = () => process.env.CI === "true";
var w2 = (t, i) => tt2 ? t : i;
var Tt = w2("◆", "*");
var at2 = w2("■", "x");
var ut2 = w2("▲", "x");
var H2 = w2("◇", "o");
var lt = w2("┌", "T");
var $2 = w2("│", "|");
var x2 = w2("└", "—");
var _t = w2("┐", "T");
var xt = w2("┘", "—");
var z2 = w2("●", ">");
var U2 = w2("○", " ");
var et2 = w2("◻", "[•]");
var K2 = w2("◼", "[+]");
var Y2 = w2("◻", "[ ]");
var Et = w2("▪", "•");
var st2 = w2("─", "-");
var ct = w2("╮", "+");
var Gt = w2("├", "+");
var $t = w2("╯", "+");
var dt = w2("╰", "+");
var Mt = w2("╭", "+");
var ht2 = w2("●", "•");
var pt = w2("◆", "*");
var mt = w2("▲", "!");
var gt = w2("■", "x");
var P2 = (t) => {
  switch (t) {
    case "initial":
    case "active":
      return e("cyan", Tt);
    case "cancel":
      return e("red", at2);
    case "error":
      return e("yellow", ut2);
    case "submit":
      return e("green", H2);
  }
};
var yt = (t) => {
  switch (t) {
    case "initial":
    case "active":
      return e("cyan", $2);
    case "cancel":
      return e("red", $2);
    case "error":
      return e("yellow", $2);
    case "submit":
      return e("green", $2);
  }
};
var Ot = (t, i, s, r, u, n = false) => {
  let a = i, c = 0;
  if (n)
    for (let o = r - 1;o >= s && (a -= t[o].length, c++, !(a <= u)); o--)
      ;
  else
    for (let o = s;o < r && (a -= t[o].length, c++, !(a <= u)); o++)
      ;
  return { lineCount: a, removals: c };
};
var F2 = ({ cursor: t, options: i, style: s, output: r = process.stdout, maxItems: u = Number.POSITIVE_INFINITY, columnPadding: n = 0, rowPadding: a = 4 }) => {
  const c = A(r) - n, o = L(r), l = e("dim", "..."), d = Math.max(o - a, 0), g = Math.max(Math.min(u, d), 5);
  let p2 = 0;
  t >= g - 3 && (p2 = Math.max(Math.min(t - g + 3, i.length - g), 0));
  let f2 = g < i.length && p2 > 0, h2 = g < i.length && p2 + g < i.length;
  const I2 = Math.min(p2 + g, i.length), m2 = [];
  let y = 0;
  f2 && y++, h2 && y++;
  const v2 = p2 + (f2 ? 1 : 0), C2 = I2 - (h2 ? 1 : 0);
  for (let b2 = v2;b2 < C2; b2++) {
    const G2 = wrapAnsi(s(i[b2], b2 === t), c, { hard: true, trim: false }).split(`
`);
    m2.push(G2), y += G2.length;
  }
  if (y > d) {
    let b2 = 0, G2 = 0, M = y;
    const N2 = t - v2;
    let O2 = d;
    const j2 = () => Ot(m2, M, 0, N2, O2), k2 = () => Ot(m2, M, N2 + 1, m2.length, O2, true);
    f2 ? ({ lineCount: M, removals: b2 } = j2(), M > O2 && (h2 || (O2 -= 1), { lineCount: M, removals: G2 } = k2())) : (h2 || (O2 -= 1), { lineCount: M, removals: G2 } = k2(), M > O2 && (O2 -= 1, { lineCount: M, removals: b2 } = j2())), b2 > 0 && (f2 = true, m2.splice(0, b2)), G2 > 0 && (h2 = true, m2.splice(m2.length - G2, G2));
  }
  const S2 = [];
  f2 && S2.push(l);
  for (const b2 of m2)
    for (const G2 of b2)
      S2.push(G2);
  return h2 && S2.push(l), S2;
};
var ue = (t) => {
  const i = t.active ?? "Yes", s = t.inactive ?? "No";
  return new X({ active: i, inactive: s, signal: t.signal, input: t.input, output: t.output, initialValue: t.initialValue ?? true, render() {
    const r = t.withGuide ?? h.withGuide, u = `${P2(this.state)}  `, n = r ? `${e("gray", $2)}  ` : "", a = W(t.output, t.message, n, u), c = `${r ? `${e("gray", $2)}
` : ""}${a}
`, o = this.value ? i : s;
    switch (this.state) {
      case "submit": {
        const l = r ? `${e("gray", $2)}  ` : "";
        return `${c}${l}${e("dim", o)}`;
      }
      case "cancel": {
        const l = r ? `${e("gray", $2)}  ` : "";
        return `${c}${l}${e(["strikethrough", "dim"], o)}${r ? `
${e("gray", $2)}` : ""}`;
      }
      default: {
        const l = r ? `${e("cyan", $2)}  ` : "", d = r ? e("cyan", x2) : "";
        return `${c}${l}${this.value ? `${e("green", z2)} ${i}` : `${e("dim", U2)} ${e("dim", i)}`}${t.vertical ? r ? `
${e("cyan", $2)}  ` : `
` : ` ${e("dim", "/")} `}${this.value ? `${e("dim", U2)} ${e("dim", s)}` : `${e("green", z2)} ${s}`}
${d}
`;
      }
    }
  } }).prompt();
};
var R2 = { message: (t = [], { symbol: i = e("gray", $2), secondarySymbol: s = e("gray", $2), output: r = process.stdout, spacing: u = 1, withGuide: n } = {}) => {
  const a = [], c = n ?? h.withGuide, o = c ? s : "", l = c ? `${i}  ` : "", d = c ? `${s}  ` : "";
  for (let p2 = 0;p2 < u; p2++)
    a.push(o);
  const g = Array.isArray(t) ? t : t.split(`
`);
  if (g.length > 0) {
    const [p2, ...f2] = g;
    p2.length > 0 ? a.push(`${l}${p2}`) : a.push(c ? i : "");
    for (const h2 of f2)
      h2.length > 0 ? a.push(`${d}${h2}`) : a.push(c ? s : "");
  }
  r.write(`${a.join(`
`)}
`);
}, info: (t, i) => {
  R2.message(t, { ...i, symbol: e("blue", ht2) });
}, success: (t, i) => {
  R2.message(t, { ...i, symbol: e("green", pt) });
}, step: (t, i) => {
  R2.message(t, { ...i, symbol: e("green", H2) });
}, warn: (t, i) => {
  R2.message(t, { ...i, symbol: e("yellow", mt) });
}, warning: (t, i) => {
  R2.warn(t, i);
}, error: (t, i) => {
  R2.message(t, { ...i, symbol: e("red", gt) });
} };
var me = (t = "", i) => {
  const s = i?.output ?? process.stdout, r = i?.withGuide ?? h.withGuide ? `${e("gray", x2)}  ` : "";
  s.write(`${r}${e("red", t)}

`);
};
var ge = (t = "", i) => {
  const s = i?.output ?? process.stdout, r = i?.withGuide ?? h.withGuide ? `${e("gray", lt)}  ` : "";
  s.write(`${r}${t}
`);
};
var ye = (t = "", i) => {
  const s = i?.output ?? process.stdout, r = i?.withGuide ?? h.withGuide ? `${e("gray", $2)}
${e("gray", x2)}  ` : "";
  s.write(`${r}${t}

`);
};
var we = (t) => e("dim", t);
var be = (t, i, s) => {
  const r = { hard: true, trim: false }, u = wrapAnsi(t, i, r).split(`
`), n = u.reduce((o, l) => Math.max(dist_default2(l), o), 0), a = u.map(s).reduce((o, l) => Math.max(dist_default2(l), o), 0), c = i - (a - n);
  return wrapAnsi(t, c, r);
};
var Se = (t = "", i = "", s) => {
  const r = s?.output ?? V2.stdout, u = s?.withGuide ?? h.withGuide, n = s?.format ?? we, a = ["", ...be(t, A(r) - 6, n).split(`
`).map(n), ""], c = dist_default2(i), o = Math.max(a.reduce((p2, f2) => {
    const h2 = dist_default2(f2);
    return h2 > p2 ? h2 : p2;
  }, 0), c) + 2, l = a.map((p2) => `${e("gray", $2)}  ${p2}${" ".repeat(o - dist_default2(p2))}${e("gray", $2)}`).join(`
`), d = u ? `${e("gray", $2)}
` : "", g = u ? Gt : dt;
  r.write(`${d}${e("green", H2)}  ${e("reset", i)} ${e("gray", st2.repeat(Math.max(o - c - 1, 1)) + ct)}
${l}
${e("gray", g + st2.repeat(o + 2) + $t)}
`);
};
var Ce = (t) => new ot({ validate: t.validate, mask: t.mask ?? Et, signal: t.signal, input: t.input, output: t.output, render() {
  const i = t.withGuide ?? h.withGuide, s = `${i ? `${e("gray", $2)}
` : ""}${P2(this.state)}  ${t.message}
`, r = this.userInputWithCursor, u = this.masked;
  switch (this.state) {
    case "error": {
      const n = i ? `${e("yellow", $2)}  ` : "", a = i ? `${e("yellow", x2)}  ` : "", c = u ?? "";
      return t.clearOnError && this.clear(), `${s.trim()}
${n}${c}
${a}${e("yellow", this.error)}
`;
    }
    case "submit": {
      const n = i ? `${e("gray", $2)}  ` : "", a = u ? e("dim", u) : "";
      return `${s}${n}${a}`;
    }
    case "cancel": {
      const n = i ? `${e("gray", $2)}  ` : "", a = u ? e(["strikethrough", "dim"], u) : "";
      return `${s}${n}${a}${u && i ? `
${e("gray", $2)}` : ""}`;
    }
    default: {
      const n = i ? `${e("cyan", $2)}  ` : "", a = i ? e("cyan", x2) : "";
      return `${s}${n}${r}
${a}
`;
    }
  }
} }).prompt();
var Te = (t) => e("magenta", t);
var ft = ({ indicator: t = "dots", onCancel: i, output: s = process.stdout, cancelMessage: r, errorMessage: u, frames: n = tt2 ? ["◒", "◐", "◓", "◑"] : ["•", "o", "O", "0"], delay: a = tt2 ? 80 : 120, signal: c, ...o } = {}) => {
  const l = ot2();
  let d, g, p2 = false, f2 = false, h2 = "", I2, m2 = performance.now();
  const y = A(s), v2 = o?.styleFrame ?? Te, C2 = (_) => {
    const A2 = _ > 1 ? u ?? h.messages.error : r ?? h.messages.cancel;
    f2 = _ === 1, p2 && (W2(A2, _), f2 && typeof i == "function" && i());
  }, S2 = () => C2(2), b2 = () => C2(1), G2 = () => {
    process.on("uncaughtExceptionMonitor", S2), process.on("unhandledRejection", S2), process.on("SIGINT", b2), process.on("SIGTERM", b2), process.on("exit", C2), c && c.addEventListener("abort", b2);
  }, M = () => {
    process.removeListener("uncaughtExceptionMonitor", S2), process.removeListener("unhandledRejection", S2), process.removeListener("SIGINT", b2), process.removeListener("SIGTERM", b2), process.removeListener("exit", C2), c && c.removeEventListener("abort", b2);
  }, N2 = () => {
    if (I2 === undefined)
      return;
    l && s.write(`
`);
    const _ = wrapAnsi(I2, y, { hard: true, trim: false }).split(`
`);
    _.length > 1 && s.write(import_sisteransi2.cursor.up(_.length - 1)), s.write(import_sisteransi2.cursor.to(0)), s.write(import_sisteransi2.erase.down());
  }, O2 = (_) => _.replace(/\.+$/, ""), j2 = (_) => {
    const A2 = (performance.now() - _) / 1000, L2 = Math.floor(A2 / 60), D2 = Math.floor(A2 % 60);
    return L2 > 0 ? `[${L2}m ${D2}s]` : `[${D2}s]`;
  }, k2 = o.withGuide ?? h.withGuide, rt2 = (_ = "") => {
    p2 = true, d = R({ output: s }), h2 = O2(_), m2 = performance.now(), k2 && s.write(`${e("gray", $2)}
`);
    let A2 = 0, L2 = 0;
    G2(), g = setInterval(() => {
      if (l && h2 === I2)
        return;
      N2(), I2 = h2;
      const D2 = v2(n[A2]);
      let Z2;
      if (l)
        Z2 = `${D2}  ${h2}...`;
      else if (t === "timer")
        Z2 = `${D2}  ${h2} ${j2(m2)}`;
      else {
        const kt = ".".repeat(Math.floor(L2)).slice(0, 3);
        Z2 = `${D2}  ${h2}${kt}`;
      }
      const Bt = wrapAnsi(Z2, y, { hard: true, trim: false });
      s.write(Bt), A2 = A2 + 1 < n.length ? A2 + 1 : 0, L2 = L2 < 4 ? L2 + 0.125 : 0;
    }, a);
  }, W2 = (_ = "", A2 = 0, L2 = false) => {
    if (!p2)
      return;
    p2 = false, clearInterval(g), N2();
    const D2 = A2 === 0 ? e("green", H2) : A2 === 1 ? e("red", at2) : e("red", ut2);
    h2 = _ ?? h2, L2 || (t === "timer" ? s.write(`${D2}  ${h2} ${j2(m2)}
`) : s.write(`${D2}  ${h2}
`)), M(), d();
  };
  return { start: rt2, stop: (_ = "") => W2(_, 0), message: (_ = "") => {
    h2 = O2(_ ?? h2);
  }, cancel: (_ = "") => W2(_, 1), error: (_ = "") => W2(_, 2), clear: () => W2("", 0, true), get isCancelled() {
    return f2;
  } };
};
var jt = { light: w2("─", "-"), heavy: w2("━", "="), block: w2("█", "#") };
var it2 = (t, i) => t.includes(`
`) ? t.split(`
`).map((s) => i(s)).join(`
`) : i(t);
var xe = (t) => {
  const i = (s, r) => {
    const u = s.label ?? String(s.value);
    switch (r) {
      case "disabled":
        return `${e("gray", U2)} ${it2(u, (n) => e("gray", n))}${s.hint ? ` ${e("dim", `(${s.hint ?? "disabled"})`)}` : ""}`;
      case "selected":
        return `${it2(u, (n) => e("dim", n))}`;
      case "active":
        return `${e("green", z2)} ${u}${s.hint ? ` ${e("dim", `(${s.hint})`)}` : ""}`;
      case "cancelled":
        return `${it2(u, (n) => e(["strikethrough", "dim"], n))}`;
      default:
        return `${e("dim", U2)} ${it2(u, (n) => e("dim", n))}`;
    }
  };
  return new ut({ options: t.options, signal: t.signal, input: t.input, output: t.output, initialValue: t.initialValue, render() {
    const s = t.withGuide ?? h.withGuide, r = `${P2(this.state)}  `, u = `${yt(this.state)}  `, n = W(t.output, t.message, u, r), a = `${s ? `${e("gray", $2)}
` : ""}${n}
`;
    switch (this.state) {
      case "submit": {
        const c = s ? `${e("gray", $2)}  ` : "", o = W(t.output, i(this.options[this.cursor], "selected"), c);
        return `${a}${o}`;
      }
      case "cancel": {
        const c = s ? `${e("gray", $2)}  ` : "", o = W(t.output, i(this.options[this.cursor], "cancelled"), c);
        return `${a}${o}${s ? `
${e("gray", $2)}` : ""}`;
      }
      default: {
        const c = s ? `${e("cyan", $2)}  ` : "", o = s ? e("cyan", x2) : "", l = a.split(`
`).length, d = s ? 2 : 1;
        return `${a}${c}${F2({ output: t.output, cursor: this.cursor, options: this.options, maxItems: t.maxItems, columnPadding: c.length, rowPadding: l + d, style: (g, p2) => i(g, g.disabled ? "disabled" : p2 ? "active" : "inactive") }).join(`
${c}`)}
${o}
`;
      }
    }
  } }).prompt();
};
var Nt = `${e("gray", $2)}  `;
var Pe = (t) => new ht({ validate: t.validate, placeholder: t.placeholder, defaultValue: t.defaultValue, initialValue: t.initialValue, output: t.output, signal: t.signal, input: t.input, render() {
  const i = t?.withGuide ?? h.withGuide, s = `${`${i ? `${e("gray", $2)}
` : ""}${P2(this.state)}  `}${t.message}
`, r = t.placeholder ? e("inverse", t.placeholder[0]) + e("dim", t.placeholder.slice(1)) : e(["inverse", "hidden"], "_"), u = this.userInput ? this.userInputWithCursor : r, n = this.value ?? "";
  switch (this.state) {
    case "error": {
      const a = this.error ? `  ${e("yellow", this.error)}` : "", c = i ? `${e("yellow", $2)}  ` : "", o = i ? e("yellow", x2) : "";
      return `${s.trim()}
${c}${u}
${o}${a}
`;
    }
    case "submit": {
      const a = n ? `  ${e("dim", n)}` : "", c = i ? e("gray", $2) : "";
      return `${s}${c}${a}`;
    }
    case "cancel": {
      const a = n ? `  ${e(["strikethrough", "dim"], n)}` : "", c = i ? e("gray", $2) : "";
      return `${s}${c}${a}${n.trim() ? `
${c}` : ""}`;
    }
    default: {
      const a = i ? `${e("cyan", $2)}  ` : "", c = i ? e("cyan", x2) : "";
      return `${s}${a}${u}
${c}
`;
    }
  }
} }).prompt();

// src/commands/hermes/types.ts
var HERMES_AGENT_TEMPLATE = "gh:delorenj/hermes-agent-template";
var SOUL_TONES2 = ["direct", "playful", "formal", "terse"];
function deriveAgentId(repo, role) {
  return `${repo}-${role}`.toLowerCase();
}

// src/commands/hermes/PromptForAgentConfig.ts
class PromptForAgentConfig extends Command2 {
  async invoke() {
    const ctx = this.context;
    const defaultRepo = basename(ctx.targetDir).toLowerCase();
    const defaultRole = "pm";
    if (ctx.yes) {
      ctx.targetRepo = (ctx.targetRepo ?? defaultRepo).toLowerCase();
      ctx.role ??= defaultRole;
      ctx.agentPurpose ??= `${ctx.role} agent for ${ctx.targetRepo}`;
      ctx.soulTone ??= "direct";
      ctx.modelProvider ??= "";
      ctx.modelName ??= "";
      ctx.skipTelegram ??= true;
      ctx.skipEmail ??= true;
      ctx.agentId = deriveAgentId(ctx.targetRepo, ctx.role);
      return {
        success: true,
        message: this.formatMessage(`✓ Non-interactive mode — using defaults  (repo=${ctx.targetRepo}, role=${ctx.role})`)
      };
    }
    ge("⚕  hermes-agent  ·  add a new agent role to this repo");
    if (!ctx.targetRepo) {
      const answer = await Pe({
        message: "Target repo name",
        placeholder: defaultRepo,
        initialValue: defaultRepo,
        validate: (v2) => v2 && v2.trim() ? undefined : "required"
      });
      if (q(answer))
        return this.cancelled();
      ctx.targetRepo = String(answer).trim().toLowerCase();
    }
    if (!ctx.role) {
      const answer = await Pe({
        message: "Role",
        placeholder: "pm",
        initialValue: defaultRole,
        validate: (v2) => /^[a-z][a-z0-9_-]*$/.test(String(v2).trim()) ? undefined : "lowercase alphanumerics, may include - or _"
      });
      if (q(answer))
        return this.cancelled();
      ctx.role = String(answer).trim();
    }
    if (!ctx.agentPurpose) {
      const answer = await Pe({
        message: "One-line purpose",
        placeholder: `${ctx.role} agent for ${ctx.targetRepo}`,
        initialValue: `${ctx.role} agent for ${ctx.targetRepo}`
      });
      if (q(answer))
        return this.cancelled();
      ctx.agentPurpose = String(answer).trim();
    }
    if (!ctx.soulTone) {
      const answer = await xe({
        message: "Personality tone",
        options: SOUL_TONES2.map((t) => ({
          value: t,
          label: t,
          hint: t === "direct" ? "decision-forward, no preamble (default)" : t === "terse" ? "minimum words, conclusion-first" : t === "playful" ? "warm, mildly funny" : "precise, structured"
        })),
        initialValue: "direct"
      });
      if (q(answer))
        return this.cancelled();
      ctx.soulTone = answer;
    }
    if (ctx.modelProvider === undefined) {
      const answer = await Pe({
        message: "Provider override (empty = inherit global)",
        placeholder: ""
      });
      if (q(answer))
        return this.cancelled();
      ctx.modelProvider = String(answer).trim();
    }
    if (ctx.modelName === undefined) {
      const answer = await Pe({
        message: "Model name override (empty = inherit global)",
        placeholder: ""
      });
      if (q(answer))
        return this.cancelled();
      ctx.modelName = String(answer).trim();
    }
    if (ctx.skipTelegram === undefined) {
      const wire = await ue({
        message: `Wire up the Telegram bot (@${ctx.targetRepo}_${ctx.role}_bot) now?`,
        initialValue: true
      });
      if (q(wire))
        return this.cancelled();
      ctx.skipTelegram = !wire;
    }
    if (ctx.skipEmail === undefined) {
      const wire = await ue({
        message: `Provision the delo.sh email address (${ctx.targetRepo}-${ctx.role}@delo.sh) now?`,
        initialValue: true
      });
      if (q(wire))
        return this.cancelled();
      ctx.skipEmail = !wire;
    }
    ctx.agentId = deriveAgentId(ctx.targetRepo, ctx.role);
    return {
      success: true,
      message: this.formatMessage(`✓ Collected agent config  (agent_id=${ctx.agentId})`)
    };
  }
  cancelled() {
    me("Aborted by user.");
    return { success: false, message: "Aborted by user." };
  }
}

// src/commands/hermes/RunCopierTemplate.ts
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
class RunCopierTemplate extends Command2 {
  async invoke() {
    const ctx = this.context;
    const { targetRepo, role, agentPurpose, soulTone, modelProvider, modelName } = ctx;
    if (!targetRepo || !role) {
      return {
        success: false,
        message: "PromptForAgentConfig must run before RunCopierTemplate (targetRepo/role unset)"
      };
    }
    const roleDir = join(ctx.targetDir, "agents", "hermes", role);
    ctx.roleDir = roleDir;
    ctx.runtimeRepo = `delorenj/agent-hm-${targetRepo}-${role}`;
    const which = spawnSync("which", ["copier"], { encoding: "utf8" });
    if (which.status !== 0) {
      return {
        success: false,
        message: "✗ copier not found on PATH.  Install with: `uv tool install copier` or `pip install copier`"
      };
    }
    if (existsSync(join(roleDir, "role.yaml")) && !ctx.force) {
      if (ctx.yes) {
        ctx.force = true;
      } else {
        const proceed = await ue({
          message: `${role}/role.yaml already exists — re-render with --overwrite?`,
          initialValue: false
        });
        if (q(proceed) || !proceed) {
          return {
            success: false,
            message: `Skipped: ${roleDir} already provisioned (use --force to re-render)`
          };
        }
        ctx.force = true;
      }
    }
    const env = {
      ...process.env,
      SKIP_TELEGRAM: "1",
      SKIP_EMAIL: "1",
      SKIP_RUNTIME_REPO: ctx.skipRuntimeRepo ? "1" : "0",
      SKIP_PLANE: ctx.skipPlane ? "1" : "0",
      SKIP_BLOODBANK: ctx.skipBloodbank ? "1" : "0",
      SKIP_SYSTEMD: ctx.skipSystemd ? "1" : "0"
    };
    const LOCAL_TEMPLATE = "/home/delorenj/code/hermes-agent-template";
    const templateSrc = process.env.PJANGLER_HERMES_TEMPLATE || (existsSync(join(LOCAL_TEMPLATE, "copier.yml")) ? LOCAL_TEMPLATE : HERMES_AGENT_TEMPLATE);
    const args = [
      "copy",
      templateSrc,
      roleDir,
      "--data",
      `target_repo=${targetRepo}`,
      "--data",
      `role=${role}`,
      "--data",
      `agent_purpose=${agentPurpose ?? ""}`,
      "--data",
      `model_provider=${modelProvider ?? ""}`,
      "--data",
      `model_name=${modelName ?? ""}`,
      "--data",
      `soul_tone=${soulTone ?? "direct"}`,
      "--trust",
      "--vcs-ref=HEAD"
    ];
    if (ctx.force)
      args.push("--overwrite");
    if (ctx.dryRun) {
      return {
        success: true,
        message: this.formatMessage(`Would run: copier ${args.join(" ")}`)
      };
    }
    mkdirSync(join(ctx.targetDir, "agents", "hermes"), { recursive: true });
    const spinner = ft();
    spinner.start(`Running copier copy  (target: agents/hermes/${role})`);
    const result = spawnSync("copier", args, {
      stdio: "inherit",
      env,
      cwd: ctx.targetDir
    });
    spinner.stop(result.status === 0 ? "✓ copier run complete" : "✗ copier failed");
    if (result.status !== 0) {
      return {
        success: false,
        message: `✗ copier exited with status ${result.status}.  Check the output above; re-run with the same flags after fixing.`
      };
    }
    return {
      success: true,
      message: `✓ Provisioned ${roleDir}  (runtime: gh:${ctx.runtimeRepo})`
    };
  }
}

// src/commands/hermes/WireTelegram.ts
import { spawnSync as spawnSync2 } from "node:child_process";
import { join as join2 } from "node:path";
import { existsSync as existsSync2, unlinkSync } from "node:fs";
class WireTelegram extends Command2 {
  async invoke() {
    const ctx = this.context;
    if (ctx.skipTelegram) {
      return { success: true, message: "→ Telegram wire-up skipped" };
    }
    if (ctx.dryRun) {
      return { success: true, message: this.formatMessage("Would run BotFather token capture") };
    }
    const { targetRepo, role, roleDir } = ctx;
    if (!targetRepo || !role || !roleDir) {
      return { success: false, message: "Cannot wire telegram: missing target_repo/role/roleDir" };
    }
    const botHandle = `${targetRepo.toLowerCase().replace(/-/g, "_")}_${role.toLowerCase()}_bot`;
    const displayName = `${cap(targetRepo)} ${role.length <= 3 ? role.toUpperCase() : cap(role)}`;
    const vaultTitle = `Telegram-Hermes-${targetRepo.toLowerCase()}-${role.toLowerCase()}`;
    const vaultRef = `op://DeLoSecrets/${vaultTitle}/token`;
    let token = process.env.TELEGRAM_BOT_TOKEN;
    let source = token ? "env" : null;
    if (!token) {
      const tryOp = spawnSync2("op", ["read", vaultRef], { encoding: "utf8" });
      if (tryOp.status === 0) {
        token = tryOp.stdout.trim();
        source = "op";
        R2.info(`✓ Telegram token loaded from ${vaultRef}`);
      }
    }
    if (!token) {
      R2.step("BotFather steps");
      R2.info([
        "  1. Open Telegram, message @BotFather",
        "  2. /newbot",
        `  3. Display name:   ${displayName}`,
        `  4. Username:       ${botHandle}   (must end in _bot)`,
        "  5. Copy the HTTP API token from the reply.",
        "  6. /setjoingroups Disable",
        "  7. /setprivacy    Disable"
      ].join(`
`));
      const tokenAnswer = await Ce({
        message: `Paste the bot token for @${botHandle}`,
        mask: "•",
        validate: (v2) => {
          const s = String(v2 ?? "").trim();
          if (!s)
            return "required";
          if (!/^[0-9]+:.+/.test(s))
            return "expected '<digits>:<secret>' shape";
        }
      });
      if (q(tokenAnswer)) {
        return { success: true, message: "→ Telegram skipped (no token).  Re-run later." };
      }
      token = String(tokenAnswer).trim();
      source = "prompt";
      const persist = await ue({
        message: `Save to ${vaultRef} for next time?`,
        initialValue: true
      });
      if (!q(persist) && persist) {
        const create = spawnSync2("op", [
          "item",
          "create",
          "--category=API Credential",
          "--vault=DeLoSecrets",
          `--title=${vaultTitle}`,
          `token=${token}`,
          `bot_handle=${botHandle}`
        ], { stdio: "inherit" });
        if (create.status !== 0) {
          R2.warn("Could not store in 1Password — token is still set for this run.");
        }
      }
    }
    const allowedAnswer = await Pe({
      message: "Your Telegram user id (allow-list for this bot)",
      placeholder: process.env.TELEGRAM_ALLOWED_USERS ?? "",
      initialValue: process.env.TELEGRAM_ALLOWED_USERS ?? "",
      validate: (v2) => /^[0-9](?:[0-9,]*[0-9])?$/.test(String(v2).trim()) ? undefined : "comma-separated numeric ids"
    });
    if (q(allowedAnswer)) {
      return { success: false, message: "✗ Aborted; Telegram step deferred." };
    }
    const script = join2(roleDir, ".scripts", "30-telegram.sh");
    if (!existsSync2(script)) {
      return {
        success: false,
        message: `✗ ${script} not found.  Did copier finish?  Re-run with --skip-runtime-repo=0 if you skipped it.`
      };
    }
    const marker = join2(roleDir, ".scripts", ".done-30-telegram");
    if (existsSync2(marker))
      unlinkSync(marker);
    const spinner = ft();
    spinner.start("Verifying token + wiring profile");
    const result = spawnSync2("bash", [script], {
      stdio: "inherit",
      env: {
        ...process.env,
        SKIP_TELEGRAM: "0",
        TELEGRAM_BOT_TOKEN: token,
        TELEGRAM_ALLOWED_USERS: String(allowedAnswer).trim()
      },
      cwd: roleDir
    });
    spinner.stop(result.status === 0 ? "✓ Telegram wired" : "✗ Telegram step failed");
    if (result.status !== 0) {
      return { success: false, message: "Telegram wire-up failed.  See output above." };
    }
    const sourceLabel = source === "env" ? " (token: env)" : source === "op" ? " (token: op)" : "";
    return { success: true, message: `✓ Telegram: @${botHandle} ready${sourceLabel}` };
  }
}
function cap(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// src/commands/hermes/WireEmail.ts
import { spawnSync as spawnSync3 } from "node:child_process";
import { join as join3 } from "node:path";
import { existsSync as existsSync3, unlinkSync as unlinkSync2 } from "node:fs";
class WireEmail extends Command2 {
  async invoke() {
    const ctx = this.context;
    if (ctx.skipEmail) {
      return { success: true, message: "→ Email wire-up skipped" };
    }
    if (ctx.dryRun) {
      return { success: true, message: this.formatMessage("Would create CF Email Routing rule") };
    }
    const { targetRepo, role, roleDir } = ctx;
    if (!targetRepo || !role || !roleDir) {
      return { success: false, message: "Cannot wire email: missing target_repo/role/roleDir" };
    }
    const script = join3(roleDir, ".scripts", "50-email.sh");
    if (!existsSync3(script)) {
      return { success: false, message: `✗ ${script} not found` };
    }
    let token = process.env.CF_EMAIL_ROUTING_TOKEN;
    if (!token) {
      const tryOp = spawnSync3("op", ["read", "op://DeLoSecrets/Cloudflare-EmailRouting/token"], { encoding: "utf8" });
      if (tryOp.status === 0) {
        token = tryOp.stdout.trim();
      }
    }
    if (!token) {
      R2.warn("CF Email Routing token not found.  Required scopes:");
      R2.info([
        "  Zone (delo.sh)  →  Email Routing Rules     : Edit",
        "  Zone (delo.sh)  →  Email Routing Settings  : Read",
        "  Account         →  Email Routing Addresses : Read",
        "Create at: https://dash.cloudflare.com/profile/api-tokens"
      ].join(`
`));
      const provideNow = await ue({
        message: "Paste a token now?  (skipping leaves email unwired until you re-run.)",
        initialValue: false
      });
      if (q(provideNow) || !provideNow) {
        return { success: true, message: "→ Email skipped (no token).  Re-run later." };
      }
      const tokenAnswer = await Ce({
        message: "CF token (will be passed via env, not stored)",
        mask: "•",
        validate: (v2) => String(v2 ?? "").trim() ? undefined : "required"
      });
      if (q(tokenAnswer)) {
        return { success: true, message: "→ Email skipped (cancelled)" };
      }
      token = String(tokenAnswer).trim();
      const persist = await ue({
        message: "Save to op://DeLoSecrets/Cloudflare-EmailRouting/token for next time?",
        initialValue: true
      });
      if (!q(persist) && persist) {
        const create = spawnSync3("op", [
          "item",
          "create",
          "--category=API Credential",
          "--vault=DeLoSecrets",
          "--title=Cloudflare-EmailRouting",
          `token=${token}`
        ], { stdio: "inherit" });
        if (create.status !== 0) {
          R2.warn("Could not store in 1Password — token is still set for this run.");
        }
      }
    }
    const marker = join3(roleDir, ".scripts", ".done-50-email");
    if (existsSync3(marker))
      unlinkSync2(marker);
    const spinner = ft();
    spinner.start("Creating Cloudflare Email Routing rule");
    const result = spawnSync3("bash", [script], {
      stdio: "inherit",
      env: { ...process.env, SKIP_EMAIL: "0", CF_EMAIL_ROUTING_TOKEN: token },
      cwd: roleDir
    });
    spinner.stop(result.status === 0 ? "✓ Email rule created" : "✗ Email step failed");
    if (result.status !== 0) {
      return { success: false, message: "Email rule creation failed.  See output above." };
    }
    return {
      success: true,
      message: `✓ Email: ${targetRepo}-${role}@delo.sh  →  jaradd@gmail.com`
    };
  }
}

// src/commands/hermes/PrintHermesSummary.ts
class PrintHermesSummary extends Command2 {
  async invoke() {
    const ctx = this.context;
    const { targetRepo, role, agentId, runtimeRepo, skipTelegram, skipEmail } = ctx;
    const botHandle = `${targetRepo?.toLowerCase().replace(/-/g, "_")}_${role?.toLowerCase()}_bot`;
    const email = `${targetRepo}-${role}@delo.sh`;
    const gw = `hermes-${agentId}-gateway.service`;
    const csm = `hermes-${agentId}-consumer.service`;
    const ckpt = `hermes-${agentId}-checkpoint.timer`;
    const lines = [];
    lines.push(`agent_id     ${agentId}`);
    lines.push(`role dir     ${ctx.roleDir}`);
    lines.push(`runtime      gh:${runtimeRepo}`);
    lines.push(`telegram     @${botHandle}${skipTelegram ? "   (NOT yet wired)" : ""}`);
    lines.push(`email        ${email}${skipEmail ? "   (NOT yet wired)" : ""}`);
    lines.push("");
    lines.push("Start daemons:");
    lines.push(`  systemctl --user start ${csm}`);
    lines.push(`  systemctl --user start ${ckpt}`);
    if (!skipTelegram) {
      lines.push(`  systemctl --user start ${gw}`);
    } else {
      lines.push(`  # gateway needs Telegram wired first (re-run with --skip-telegram=0)`);
    }
    lines.push("");
    lines.push("Talk locally:");
    lines.push(`  ${ctx.roleDir}/hermes chat "status"`);
    if (skipTelegram || skipEmail) {
      lines.push("");
      lines.push("Deferred — re-run pjangler hermes-agent without --yes (or with explicit flags):");
      if (skipTelegram)
        lines.push("  pjangler hermes-agent --skip-telegram=false   # wire just telegram");
      if (skipEmail)
        lines.push("  pjangler hermes-agent --skip-email=false      # wire just email");
    }
    Se(lines.join(`
`), `Provisioned ${agentId}`);
    ye("Done.");
    return { success: true, message: "" };
  }
}

// src/recipes/HermesAgentRecipe.ts
class HermesAgentRecipe extends Recipe {
  constructor(context) {
    super(context);
    this.addIngredient(PromptForAgentConfig).addIngredient(RunCopierTemplate).addIngredient(WireTelegram).addIngredient(WireEmail).addIngredient(PrintHermesSummary);
  }
  async execute() {
    for (const command of this.ingredients) {
      const result = await command.invoke();
      if (!result.success && result.message.startsWith("✗")) {
        console.error(result.message);
        return;
      }
      if (result.message && !result.message.startsWith("✓ Collected")) {
        if (result.message.startsWith("→") || result.message.startsWith("✓ Provisioned")) {
          console.log(result.message);
        }
      }
    }
  }
  printNextSteps() {}
}

// src/utils/registry.ts
var RECIPE_REGISTRY = {
  mise: {
    name: "mise",
    description: "Mise task runner and environment setup",
    class: MiseRecipe,
    commands: ["AddMiseToml", "AddDotenv", "AddMiseTasksStructure", "AddMiseBaseToml", "AddMiseBaseScript"]
  },
  docker: {
    name: "docker",
    description: "Docker containerization setup",
    class: DockerRecipe,
    commands: ["AddDockerfile", "AddDockerCompose", "AddDockerignore"]
  },
  node: {
    name: "node",
    description: "Node.js project template",
    class: NodeRecipe,
    commands: ["NodeCommands"]
  },
  "hermes-agent": {
    name: "hermes-agent",
    description: "Add a Hermes agent role to this repo (copier + BotFather + CF email + submodule)",
    class: HermesAgentRecipe,
    commands: [
      "PromptForAgentConfig",
      "RunCopierTemplate",
      "WireTelegram",
      "WireEmail",
      "PrintHermesSummary"
    ]
  }
};
var COMMAND_REGISTRY = {
  AddDockerfile: {
    name: "AddDockerfile",
    description: "Create Dockerfile for containerization",
    group: "docker",
    class: AddDockerfile
  },
  AddDockerCompose: {
    name: "AddDockerCompose",
    description: "Create docker-compose.yml for multi-service setup",
    group: "docker",
    class: AddDockerCompose
  },
  AddDockerignore: {
    name: "AddDockerignore",
    description: "Create .dockerignore file",
    group: "docker",
    class: AddDockerignore
  },
  AddMiseToml: {
    name: "AddMiseToml",
    description: "Create mise.toml for version management",
    group: "mise",
    class: AddMiseToml
  },
  AddMiseBaseToml: {
    name: "AddMiseBaseToml",
    description: "Create base mise configuration",
    group: "mise",
    class: AddMiseBaseToml
  },
  AddMiseTasksStructure: {
    name: "AddMiseTasksStructure",
    description: "Create .mise/tasks directory structure",
    group: "mise",
    class: AddMiseTasksStructure
  },
  AddMiseBaseScript: {
    name: "AddMiseBaseScript",
    description: "Create base mise task scripts",
    group: "mise",
    class: AddMiseBaseScript
  },
  AddDotenv: {
    name: "AddDotenv",
    description: "Create .env.example file",
    group: "environment",
    class: AddDotenv
  }
};
function getRecipeNames() {
  return Object.keys(RECIPE_REGISTRY);
}
function getRecipeInfo(name) {
  return RECIPE_REGISTRY[name] || null;
}
function getCommandNames() {
  return Object.keys(COMMAND_REGISTRY);
}
function getCommandInfo(name) {
  return COMMAND_REGISTRY[name] || null;
}
function getCommandsByGroup() {
  const grouped = {};
  for (const cmdInfo of Object.values(COMMAND_REGISTRY)) {
    if (!grouped[cmdInfo.group]) {
      grouped[cmdInfo.group] = [];
    }
    grouped[cmdInfo.group].push(cmdInfo);
  }
  return grouped;
}
function createRecipe(name, context) {
  const info = getRecipeInfo(name);
  if (!info)
    return null;
  return new info.class(context);
}

// src/index.ts
var program2 = new Command;
program2.name("pjangler").description("Project subsystem bootstrapper CLI").version("1.0.0");
program2.command("init").argument("<subsystem>", "Subsystem to initialize").description("Initialize a project subsystem").option("--dry-run", "Preview changes without writing files").option("-f, --force", "Overwrite existing files").action(async (subsystem, options) => {
  const context = {
    targetDir: process.cwd(),
    force: options.force || false,
    dryRun: options.dryRun || false
  };
  try {
    const recipe = createRecipe(subsystem, context);
    if (!recipe) {
      console.error(`\u274C Unknown subsystem: ${subsystem}`);
      console.log(`Available subsystems: ${getRecipeNames().join(", ")}`);
      process.exit(1);
    }
    await recipe.execute();
  } catch (error) {
    console.error(`\u274C Error initializing ${subsystem}:`, error);
    process.exit(1);
  }
});
program2.command("list").description("List available subsystems").action(() => {
  console.log("Available subsystems:");
  console.log("");
  for (const [name, info] of Object.entries(RECIPE_REGISTRY)) {
    console.log(`  ${name.padEnd(10)} - ${info.description}`);
  }
  console.log("");
  console.log("Usage examples:");
  console.log("  pjangler init mise");
  console.log("  pjangler init docker");
  console.log("  pjangler init node");
});
var recipeCmd = program2.command("recipe").description("Manage pjangler recipes");
recipeCmd.command("list").description("List all available recipes").action(() => {
  console.log("\uD83D\uDCE6 Available Recipes:");
  console.log("");
  for (const [name, info] of Object.entries(RECIPE_REGISTRY)) {
    console.log(`  ${name}`);
    console.log(`    ${info.description}`);
    console.log(`    Commands: ${info.commands.join(", ")}`);
    console.log("");
  }
  console.log("Usage:");
  console.log("  pjangler recipe run <name>");
  console.log("  pjangler recipe describe <name>");
});
recipeCmd.command("describe").argument("<name>", "Recipe name").description("Show detailed information about a recipe").action((name) => {
  const info = getRecipeInfo(name);
  if (!info) {
    console.error(`\u274C Recipe not found: ${name}`);
    console.log(`Available recipes: ${getRecipeNames().join(", ")}`);
    process.exit(1);
  }
  console.log(`\uD83D\uDCE6 Recipe: ${info.name}`);
  console.log("");
  console.log(`Description: ${info.description}`);
  console.log("");
  console.log("Commands:");
  for (const cmd of info.commands) {
    console.log(`  - ${cmd}`);
  }
  console.log("");
  console.log("Usage:");
  console.log(`  pjangler recipe run ${name}`);
  console.log(`  pjangler init ${name}`);
});
recipeCmd.command("run").argument("<name>", "Recipe name").description("Execute a specific recipe").option("--dry-run", "Preview changes without writing files").option("-f, --force", "Overwrite existing files").action(async (name, options) => {
  const context = {
    targetDir: process.cwd(),
    force: options.force || false,
    dryRun: options.dryRun || false
  };
  try {
    const recipe = createRecipe(name, context);
    if (!recipe) {
      console.error(`\u274C Recipe not found: ${name}`);
      console.log(`Available recipes: ${getRecipeNames().join(", ")}`);
      process.exit(1);
    }
    const dryRunPrefix = context.dryRun ? "[DRY RUN] " : "";
    console.log(`${dryRunPrefix}\uD83D\uDE80 Running recipe: ${name}`);
    console.log("");
    await recipe.execute();
  } catch (error) {
    console.error(`\u274C Error running recipe ${name}:`, error);
    process.exit(1);
  }
});
var commandCmd = program2.command("command").alias("cmd").description("Manage pjangler commands");
commandCmd.command("list").description("List all available commands").option("-g, --group", "Group commands by category").action((options) => {
  if (options.group) {
    console.log("\u2699\uFE0F  Available Commands (Grouped):");
    console.log("");
    const grouped = getCommandsByGroup();
    for (const [group, commands] of Object.entries(grouped)) {
      console.log(`  ${group.toUpperCase()}:`);
      for (const cmd of commands) {
        console.log(`    ${cmd.name.padEnd(30)} - ${cmd.description}`);
      }
      console.log("");
    }
  } else {
    console.log("\u2699\uFE0F  Available Commands:");
    console.log("");
    for (const [name, info] of Object.entries(COMMAND_REGISTRY)) {
      console.log(`  ${name.padEnd(30)} - ${info.description}`);
    }
    console.log("");
  }
  console.log("Usage:");
  console.log("  pj command list --group    # Group by category");
  console.log("  pj command describe <name> # Show command details");
});
commandCmd.command("describe").argument("<name>", "Command name").description("Show detailed information about a command").action((name) => {
  const info = getCommandInfo(name);
  if (!info) {
    console.error(`\u274C Command not found: ${name}`);
    console.log(`Available commands: ${getCommandNames().join(", ")}`);
    process.exit(1);
  }
  console.log(`\u2699\uFE0F  Command: ${info.name}`);
  console.log("");
  console.log(`Description: ${info.description}`);
  console.log(`Group: ${info.group}`);
  console.log("");
  console.log("This command is used in recipes:");
  for (const [recipeName, recipeInfo] of Object.entries(RECIPE_REGISTRY)) {
    if (recipeInfo.commands.includes(name)) {
      console.log(`  - ${recipeName}`);
    }
  }
  console.log("");
  console.log("Usage:");
  console.log(`  Part of recipe execution (not run directly)`);
});
commandCmd.command("create").argument("<name>", "Command name").argument("<prompt>", "Description of what the command should do").description("Create a new command from template (placeholder for STORY-005)").option("-t, --template <type>", "Template type (toml, json, yaml, dockerfile)").option("-m, --model <model>", "LLM model to use (OpenRouter)").action((name, prompt, options) => {
  console.log("\uD83D\uDEA7 Command generation coming in STORY-005!");
  console.log("");
  console.log("Planned features:");
  console.log(`  - Generate ${name} from prompt: "${prompt}"`);
  if (options.template) {
    console.log(`  - Template type: ${options.template}`);
  }
  if (options.model) {
    console.log(`  - LLM model: ${options.model}`);
  }
  console.log("");
  console.log("This feature will be implemented in the Template Generation System story.");
  console.log("For now, manually create commands in src/commands/");
});
program2.command("hermes-agent").alias("hermes").description("Provision a Hermes agent role into the current repo (TUI; --yes for non-interactive)").option("-y, --yes", "Non-interactive: accept all defaults (skips Telegram + email)").option("--target-repo <name>", "Target repo name (default: basename of cwd)").option("--role <role>", "Agent role (pm | dev | review | ops | qa | ci | ...)").option("--purpose <text>", "One-line agent purpose").option(`--tone <tone>`, `Personality tone (${SOUL_TONES.join(" | ")})`).option("--model-provider <name>", 'Inference provider override ("" = inherit global)').option("--model-name <name>", 'Model name override ("" = inherit global)').option("--skip-telegram", "Skip BotFather token capture step").option("--skip-email", "Skip Cloudflare Email Routing step").option("--skip-runtime-repo", "Skip creating the per-agent runtime GH repo").option("--skip-plane", "Skip creating the Plane project").option("--skip-bloodbank", "Skip installing the Bloodbank NATS consumer").option("--skip-systemd", "Skip installing systemd --user units").option("--dry-run", "Preview what would run; don't execute copier").option("-f, --force", "Re-render even if agents/hermes/<role>/role.yaml already exists").action(async (options) => {
  const context = {
    targetDir: process.cwd(),
    force: options.force ?? false,
    dryRun: options.dryRun ?? false,
    yes: options.yes ?? false,
    targetRepo: options.targetRepo,
    role: options.role,
    agentPurpose: options.purpose,
    soulTone: options.tone,
    modelProvider: options.modelProvider,
    modelName: options.modelName,
    skipTelegram: options.skipTelegram,
    skipEmail: options.skipEmail,
    skipRuntimeRepo: options.skipRuntimeRepo,
    skipPlane: options.skipPlane,
    skipBloodbank: options.skipBloodbank,
    skipSystemd: options.skipSystemd
  };
  try {
    const recipe = createRecipe("hermes-agent", context);
    if (!recipe) {
      console.error("\u274C hermes-agent recipe not registered");
      process.exit(1);
    }
    await recipe.execute();
  } catch (err) {
    console.error("\u274C hermes-agent failed:", err);
    process.exit(1);
  }
});
program2.command("describe").description("Describe the current project (for AI context)").action(() => {
  console.log("\uD83D\uDD0D Project Description (placeholder for future enhancement)");
  console.log("");
  console.log("This command will analyze the project and provide:");
  console.log("  - Detected project type");
  console.log("  - Installed subsystems");
  console.log("  - Configuration files present");
  console.log("  - Suggested next steps");
  console.log("");
  console.log("Coming soon!");
});
program2.parse();
