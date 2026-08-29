e(
  // Cobblemon Daycare XP: configuration, session state, events, and commands.
  function () {
    const LOG_TAG = "GNL Daycare";
    const VARIABLE_PREFIX = "nogDaycareVariable_";
    const DEBUGGER_PREFIX = "nogDaycareDebugger_";
    const $Component = Java.loadClass("net.minecraft.network.chat.Component");
    const $BoolArgumentType = Java.loadClass(
      "com.mojang.brigadier.arguments.BoolArgumentType",
    );
    const $IntegerArgumentType = Java.loadClass(
      "com.mojang.brigadier.arguments.IntegerArgumentType",
    );
    const $SidemodExperienceSource = Java.loadClass(
      "com.cobblemon.mod.common.api.pokemon.experience.SidemodExperienceSource",
    );
    const DAYCARE_XP_SOURCE = new $SidemodExperienceSource("gnl_daycare");

    // Persistent configuration stays in the main file so it is easy to find.
    const DAYCARE_VARIABLES = {
      xp_per_milestone: { type: "integer", defaultValue: 1, minimum: 0 },
      blocks_per_milestone: {
        type: "integer",
        defaultValue: 1,
        minimum: 1,
        legacyName: "blocks_per_xp_milestone",
      },
      check_interval_seconds: { type: "integer", defaultValue: 10, minimum: 1 },
      levelUpNotification: { type: "boolean", defaultValue: true },
    };

    const DEBUGGERS = {
      walk: { type: "boolean", defaultValue: false },
      level_gained: { type: "boolean", defaultValue: false },
    };

    // All of this state is local to the current server session.
    const STATE = {
      positionSampleTickCounter: 0,
      lastPositions: new Map(),
      currentPositions: new Map(),
      distanceRemaindersByPlayer: new Map(),
      pendingXpByPlayer: new Map(),
      pasturedPokemonIdsByPlayer: new Map(),
      pcChangeSubscriptions: new Map(),
      sleepingPlayers: new Set(),
    };

    function GetVariable(server, name) {
      return global.Nog.Helpers.GetPersistentValue(
        server,
        DAYCARE_VARIABLES,
        VARIABLE_PREFIX,
        name,
      );
    }

    function SetVariable(server, name, value) {
      return global.Nog.Helpers.SetPersistentValue(
        server,
        DAYCARE_VARIABLES,
        VARIABLE_PREFIX,
        name,
        value,
      );
    }

    function GetDebugger(server, name) {
      return global.Nog.Helpers.GetPersistentValue(
        server,
        DEBUGGERS,
        DEBUGGER_PREFIX,
        name,
      );
    }

    function SetDebugger(server, name, value) {
      return global.Nog.Helpers.SetPersistentValue(
        server,
        DEBUGGERS,
        DEBUGGER_PREFIX,
        name,
        value,
      );
    }

    function Tell(player, message) {
      player.sendSystemMessage($Component.literal(String(message)));
    }

    function HandlePlayerInterval(player, server) {
      let Daycare = global.Nog.CobblemonDaycare;
      let playerKey = Daycare.PlayerKey(player);
      let currentPosition = {
        x: Number(player.getX()),
        z: Number(player.getZ()),
      };
      STATE.currentPositions.set(playerKey, currentPosition);
      let lastPosition = STATE.lastPositions.get(playerKey);
      let distance = 0;
      if (lastPosition != null) {
        let deltaX = currentPosition.x - lastPosition.x;
        let deltaZ = currentPosition.z - lastPosition.z;
        distance = Math.sqrt(deltaX * deltaX + deltaZ * deltaZ);
      }
      STATE.lastPositions.set(playerKey, currentPosition);

      // Sleeping players retain a fresh position baseline but do no daycare work.
      if (STATE.sleepingPlayers.has(playerKey)) return;

      let stats = Daycare.GetStats(player, STATE);
      let generatedXp = 0;
      if (stats.eligiblePokemonCount > 0) {
        generatedXp = Daycare.GeneratePendingXp(
          STATE,
          playerKey,
          distance,
          GetVariable(server, "blocks_per_milestone"),
          GetVariable(server, "xp_per_milestone"),
        );
      }

      let appliedXp = Daycare.ApplyPendingXp(
        player,
        STATE,
        DAYCARE_XP_SOURCE,
        GetVariable(server, "levelUpNotification"),
      );
      stats = Daycare.GetStats(player, STATE);
      let pendingXp = Number(STATE.pendingXpByPlayer.get(playerKey) || 0);
      let plan = Daycare.PlanDistribution(stats.eligiblePokemonIds, pendingXp);

      if (GetDebugger(server, "walk")) {
        Tell(
          player,
          "Distance since last position: " +
            distance.toFixed(1).replace(".", ",") +
            " | XP generated: " +
            generatedXp +
            " | XP applied: " +
            appliedXp +
            " | Hypothetical XP: " +
            pendingXp +
            " | XP per Pokemon: " +
            plan.xpPerPokemon +
            " | XP preserved for next batch: " +
            plan.preservedXp +
            " | Total pastured Pokemon: " +
            stats.totalPokemonCount +
            " | Current player cap: " +
            stats.currentLevelCap +
            " | Level-capped ignored: " +
            stats.cappedPokemonCount,
        );
      }
    }

    ServerEvents.tick(function (event) {
      STATE.positionSampleTickCounter++;
      let interval = global.Nog.Helpers.SecondsToTicks(
        GetVariable(event.server, "check_interval_seconds"),
      );
      if (STATE.positionSampleTickCounter < interval) return;
      STATE.positionSampleTickCounter = 0;

      let players = event.server.getPlayerList().getPlayers().iterator();
      while (players.hasNext()) {
        try {
          HandlePlayerInterval(players.next(), event.server);
        } catch (error) {
          global.Nog.Helpers.LogError(LOG_TAG, "player interval", error);
        }
      }
    });

    ServerEvents.loaded(function (event) {
      let players = event.server.getPlayerList().getPlayers().iterator();
      while (players.hasNext())
        global.Nog.CobblemonDaycare.SubscribePlayer(players.next(), STATE);
    });

    PlayerEvents.loggedIn(function (event) {
      global.Nog.CobblemonDaycare.SubscribePlayer(event.player, STATE);
    });

    PlayerEvents.loggedOut(function (event) {
      global.Nog.CobblemonDaycare.CleanupPlayer(
        String(event.player.uuid),
        STATE,
      );
    });

    ServerEvents.unloaded(function () {
      global.Nog.CobblemonDaycare.CleanupAll(STATE);
      STATE.positionSampleTickCounter = 0;
    });

    function RequirePlayer(context) {
      return context.source.player;
    }

    function RunTest(context) {
      let player = RequirePlayer(context);
      if (player == null) return 0;
      Tell(player, "Hi! This is my script!");
      return 1;
    }

    function RunMyPasturedCobblemons(context) {
      let player = RequirePlayer(context);
      if (player == null) return 0;
      let playerKey = global.Nog.CobblemonDaycare.PlayerKey(player);
      let ids = STATE.pasturedPokemonIdsByPlayer.get(playerKey) || [];
      if (ids.length === 0) {
        Tell(player, "You have no Pokemon currently on a Pasture.");
        return 1;
      }
      let displayed = 0;
      for (let index = 0; index < ids.length; index++) {
        let pokemon = global.Nog.Cobblemon.FindPokemonInPlayerPcStores(
          player,
          ids[index],
        );
        if (!global.Nog.Cobblemon.IsTethered(pokemon)) continue;
        Tell(
          player,
          "[" +
            global.Nog.Cobblemon.GetPokemonName(pokemon) +
            "] Lv [" +
            Number(pokemon.getLevel()) +
            "]",
        );
        displayed++;
      }
      if (displayed === 0)
        Tell(player, "You have no Pokemon currently on a Pasture.");
      return 1;
    }

    function RunDebuggerStatus(context) {
      let player = RequirePlayer(context);
      if (player == null) return 0;
      let names = Object.keys(DEBUGGERS);
      for (let index = 0; index < names.length; index++) {
        let enabled = GetDebugger(player.server, names[index]);
        Tell(
          player,
          names[index] +
            ": " +
            (enabled ? "active (true)" : "inactive (false)"),
        );
      }
      return 1;
    }

    function CreateSetDebugger(name) {
      return function (context) {
        let player = RequirePlayer(context);
        if (player == null) return 0;
        let enabled = $BoolArgumentType.getBool(context, "enabled");
        SetDebugger(player.server, name, enabled);
        Tell(
          player,
          name +
            " is now " +
            (enabled ? "active (true)." : "inactive (false)."),
        );
        return 1;
      };
    }

    function SendVariable(player, name) {
      Tell(player, name + ": " + String(GetVariable(player.server, name)));
    }

    function RunAllVariables(context) {
      let player = RequirePlayer(context);
      if (player == null) return 0;
      let names = Object.keys(DAYCARE_VARIABLES);
      for (let index = 0; index < names.length; index++)
        SendVariable(player, names[index]);
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
        let definition = DAYCARE_VARIABLES[name];
        let value =
          definition.type === "boolean"
            ? $BoolArgumentType.getBool(context, "value")
            : $IntegerArgumentType.getInteger(context, "value");
        if (!SetVariable(player.server, name, value)) {
          Tell(player, "Invalid value for " + name + ".");
          return 0;
        }
        SendVariable(player, name);
        return 1;
      };
    }

    ServerEvents.commandRegistry(function (event) {
      let Commands = event.commands;
      let debuggerSet = Commands.literal("set");
      let debuggerNames = Object.keys(DEBUGGERS);
      for (let index = 0; index < debuggerNames.length; index++) {
        let debuggerName = debuggerNames[index];
        debuggerSet.then(
          Commands.literal(debuggerName).then(
            Commands.argument("enabled", $BoolArgumentType.bool()).executes(
              CreateSetDebugger(debuggerName),
            ),
          ),
        );
      }
      let debuggerCommand = Commands.literal("debuggers_status")
        .executes(RunDebuggerStatus)
        .then(debuggerSet);

      let variablesCommand =
        Commands.literal("variables").executes(RunAllVariables);
      let variableNames = Object.keys(DAYCARE_VARIABLES);
      for (let index = 0; index < variableNames.length; index++) {
        let variableName = variableNames[index];
        let definition = DAYCARE_VARIABLES[variableName];
        let valueArgument =
          definition.type === "boolean"
            ? Commands.argument("value", $BoolArgumentType.bool())
            : Commands.argument(
                "value",
                $IntegerArgumentType.integer(definition.minimum),
              );
        let variableCommand = Commands.literal(variableName)
          .executes(CreateShowVariable(variableName))
          .then(
            Commands.literal("set").then(
              valueArgument.executes(CreateSetVariable(variableName)),
            ),
          );
        variablesCommand.then(variableCommand);
      }

      event.register(
        Commands.literal("daycarexp")
          .then(Commands.literal("test").executes(RunTest))
          .then(
            Commands.literal("mypasturedcobblemons").executes(
              RunMyPasturedCobblemons,
            ),
          )
          .then(debuggerCommand)
          .then(variablesCommand),
      );
    });

    console.info("[" + LOG_TAG + "] Runtime loaded.");
  },
)();
