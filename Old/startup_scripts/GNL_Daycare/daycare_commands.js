// /daycarexp command behavior and Brigadier command-tree construction.
global.Nog = global.Nog || {};
global.Nog.CobblemonDaycareCommands = global.Nog.CobblemonDaycareCommands || {};

(function (DaycareCommands) {
  const $BoolArgumentType = Java.loadClass("com.mojang.brigadier.arguments.BoolArgumentType");
  const $IntegerArgumentType = Java.loadClass("com.mojang.brigadier.arguments.IntegerArgumentType");

  function RequirePlayer(context) {
    return context.source.player;
  }

  function Register(event, runtime) {
    let Commands = event.commands;
    let state = runtime.state;
    let Daycare = global.Nog.CobblemonDaycare;

    function RunTest(context) {
      let player = RequirePlayer(context);
      if (player == null) return 0;
      global.Nog.Helpers.Tell(player, "Hi! This is my script!");
      return 1;
    }

    function RunPasturedList(context) {
      let player = RequirePlayer(context);
      if (player == null) return 0;
      let ids = state.pasturedPokemonIdsByPlayer.get(Daycare.PlayerKey(player)) || [];
      if (ids.length === 0) {
        global.Nog.Helpers.Tell(player, "You have no Pokemon currently on a Pasture.");
        return 1;
      }
      let displayed = 0;
      for (let index = 0; index < ids.length; index++) {
        let pokemon = global.Nog.Cobblemon.FindPokemonInPlayerPcStores(player, ids[index]);
        if (!global.Nog.Cobblemon.IsTethered(pokemon)) continue;
        global.Nog.Helpers.Tell(
          player,
          index + 1 + ": [" + global.Nog.Cobblemon.GetPokemonName(pokemon) +
            "] Lv [" + Number(pokemon.getLevel()) + "]",
        );
        displayed++;
      }
      if (displayed === 0) {
        global.Nog.Helpers.Tell(player, "You have no Pokemon currently on a Pasture.");
      }
      return 1;
    }

    function RunTrack(context) {
      let player = RequirePlayer(context);
      if (player == null) return 0;
      let requestedIndex = $IntegerArgumentType.getInteger(context, "index");
      let enabled = $BoolArgumentType.getBool(context, "enabled");
      let playerKey = Daycare.PlayerKey(player);
      if (!enabled) {
        let disabled = Daycare.DeactivateTracker(player, state, null);
        global.Nog.Helpers.Tell(
          player,
          disabled ? "Pokemon tracker disabled." : "No Pokemon tracker was active.",
        );
        return 1;
      }

      let ids = state.pasturedPokemonIdsByPlayer.get(playerKey) || [];
      let arrayIndex = requestedIndex - 1;
      if (arrayIndex < 0 || arrayIndex >= ids.length) {
        global.Nog.Helpers.Tell(
          player,
          "Invalid Pasture list index. Current list size: " + ids.length + ".",
        );
        return 0;
      }
      let pokemon = global.Nog.Cobblemon.FindPokemonInPlayerPcStores(player, ids[arrayIndex]);
      if (!global.Nog.Cobblemon.IsTethered(pokemon)) {
        global.Nog.Helpers.Tell(player, "That Pasture list entry is no longer available.");
        return 0;
      }

      Daycare.DeactivateTracker(player, state, null);
      let startingProgress = Daycare.GetXpProgress(pokemon);
      state.trackedPokemonByPlayer.set(playerKey, {
        pokemonUuid: ids[arrayIndex],
        listSignature: Daycare.PokemonIdSignature(ids),
        startingProgress: startingProgress,
      });
      global.Nog.Helpers.Tell(
        player,
        "Tracking [" + global.Nog.Cobblemon.GetPokemonName(pokemon) +
          "] at Pasture list index " + requestedIndex + ".",
      );
      global.Nog.Helpers.Tell(player, "Before: " + Daycare.FormatXpProgress(startingProgress));
      return 1;
    }

    function RunDebuggerStatus(context) {
      let player = RequirePlayer(context);
      if (player == null) return 0;
      let names = Object.keys(runtime.debuggerDefinitions);
      for (let index = 0; index < names.length; index++) {
        let enabled = runtime.getDebugger(player.server, names[index]);
        global.Nog.Helpers.Tell(
          player,
          names[index] + ": " + (enabled ? "active (true)" : "inactive (false)"),
        );
      }
      return 1;
    }

    function CreateSetDebugger(name) {
      return function (context) {
        let player = RequirePlayer(context);
        if (player == null) return 0;
        let enabled = $BoolArgumentType.getBool(context, "enabled");
        runtime.setDebugger(player.server, name, enabled);
        global.Nog.Helpers.Tell(
          player,
          name + " is now " + (enabled ? "active (true)." : "inactive (false)."),
        );
        return 1;
      };
    }

    function SendVariable(player, name) {
      global.Nog.Helpers.Tell(player, name + ": " + runtime.getVariable(player.server, name));
    }

    function RunAllVariables(context) {
      let player = RequirePlayer(context);
      if (player == null) return 0;
      let names = Object.keys(runtime.variableDefinitions);
      for (let index = 0; index < names.length; index++) SendVariable(player, names[index]);
      return 1;
    }

    function CreateShowVariable(name) {
      return function (context) {
        let player = RequirePlayer(context);
        if (player == null) return 0;
        SendVariable(player, name);
        return 1;
      };
    }

    function CreateSetVariable(name) {
      return function (context) {
        let player = RequirePlayer(context);
        if (player == null) return 0;
        let definition = runtime.variableDefinitions[name];
        let value = definition.type === "boolean"
          ? $BoolArgumentType.getBool(context, "value")
          : $IntegerArgumentType.getInteger(context, "value");
        if (!runtime.setVariable(player.server, name, value)) return 0;
        SendVariable(player, name);
        return 1;
      };
    }

    let debuggerSet = Commands.literal("set");
    let debuggerNames = Object.keys(runtime.debuggerDefinitions);
    for (let index = 0; index < debuggerNames.length; index++) {
      let debuggerName = debuggerNames[index];
      debuggerSet.then(Commands.literal(debuggerName).then(
        Commands.argument("enabled", $BoolArgumentType.bool())
          .executes(CreateSetDebugger(debuggerName)),
      ));
    }
    let debuggerCommand = Commands.literal("debuggers_status")
      .executes(RunDebuggerStatus)
      .then(debuggerSet);

    let variablesCommand = Commands.literal("variables").executes(RunAllVariables);
    let variableNames = Object.keys(runtime.variableDefinitions);
    for (let index = 0; index < variableNames.length; index++) {
      let name = variableNames[index];
      let definition = runtime.variableDefinitions[name];
      let argument = definition.type === "boolean"
        ? Commands.argument("value", $BoolArgumentType.bool())
        : Commands.argument("value", $IntegerArgumentType.integer(definition.minimum));
      variablesCommand.then(Commands.literal(name).executes(CreateShowVariable(name)).then(
        Commands.literal("set").then(argument.executes(CreateSetVariable(name))),
      ));
    }

    event.register(Commands.literal("daycarexp")
      .then(Commands.literal("test").executes(RunTest))
      .then(Commands.literal("track").then(
        Commands.argument("index", $IntegerArgumentType.integer(1)).then(
          Commands.argument("enabled", $BoolArgumentType.bool()).executes(RunTrack),
        ),
      ))
      .then(Commands.literal("mypasturedcobblemons").executes(RunPasturedList))
      .then(debuggerCommand)
      .then(variablesCommand));
  }

  DaycareCommands.Register = Register;
})(global.Nog.CobblemonDaycareCommands);
