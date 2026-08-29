// KubeJS server-script template for Minecraft 1.21.1.
//
// This file is outside server_scripts, so KubeJS will not execute it.
// Copy only the sections you need into a file under server_scripts.

(function () {
  // =============================================================
  // JAVA IMPORTS
  // =============================================================

  const $Component = Java.loadClass("net.minecraft.network.chat.Component");
  const $IntegerArgumentType = Java.loadClass(
    "com.mojang.brigadier.arguments.IntegerArgumentType",
  );

  // =============================================================
  // CONSTANT CONFIGURATION
  // =============================================================

  const SCRIPT_NAME = "My KubeJS Script";
  const DEFAULT_INTERVAL_SECONDS = 5;
  const TICKS_PER_SECOND = 20;

  // =============================================================
  // TEMPORARY RUNTIME STATE
  // =============================================================

  // These values disappear when the script/server is unloaded.
  let tickCounter = 0;
  let temporaryValuesByPlayer = new Map();

  // =============================================================
  // SMALL REUSABLE FUNCTIONS
  // =============================================================

  function GetPlayerKey(player) {
    return String(player.uuid);
  }

  function Tell(player, message) {
    player.sendSystemMessage($Component.literal(String(message)));
  }

  function GetSavedNumber(server) {
    let key = "myScriptSavedNumber";

    if (!server.persistentData.contains(key)) {
      server.persistentData.putInt(key, 10);
    }

    return Number(server.persistentData.getInt(key));
  }

  function SetSavedNumber(server, value) {
    let integerValue = Math.floor(Number(value));

    if (!isFinite(integerValue) || integerValue < 0) {
      return false;
    }

    server.persistentData.putInt("myScriptSavedNumber", integerValue);
    return true;
  }

  // =============================================================
  // SERVER LOAD AND UNLOAD
  // =============================================================

  ServerEvents.loaded(function (event) {
    console.info("[" + SCRIPT_NAME + "] Server script loaded.");

    // Read or initialize persistent configuration here.
    GetSavedNumber(event.server);
  });

  ServerEvents.unloaded(function () {
    // Release temporary references when the server stops or scripts reload.
    temporaryValuesByPlayer.clear();
    tickCounter = 0;
  });

  // =============================================================
  // PLAYER LOGIN AND LOGOUT
  // =============================================================

  PlayerEvents.loggedIn(function (event) {
    let player = event.player;
    let playerKey = GetPlayerKey(player);

    temporaryValuesByPlayer.set(playerKey, {
      exampleCounter: 0,
    });

    Tell(player, "Welcome! The example script is active.");
  });

  PlayerEvents.loggedOut(function (event) {
    temporaryValuesByPlayer.delete(GetPlayerKey(event.player));
  });

  // =============================================================
  // REPEATING SERVER TICK
  // =============================================================

  ServerEvents.tick(function (event) {
    tickCounter++;

    let intervalTicks = DEFAULT_INTERVAL_SECONDS * TICKS_PER_SECOND;
    if (tickCounter < intervalTicks) {
      return;
    }

    tickCounter = 0;

    let players = event.server.getPlayerList().getPlayers().iterator();

    while (players.hasNext()) {
      let player = players.next();
      let playerKey = GetPlayerKey(player);
      let playerState = temporaryValuesByPlayer.get(playerKey);

      if (playerState == null) {
        playerState = { exampleCounter: 0 };
        temporaryValuesByPlayer.set(playerKey, playerState);
      }

      playerState.exampleCounter++;

      // Put behavior that should repeat for each player here.
    }
  });

  // =============================================================
  // BLOCK EVENTS
  // =============================================================

  BlockEvents.placed(function (event) {
    let player = event.player;

    if (player == null) {
      return;
    }

    // Example filter:
    if (String(event.block.id) !== "minecraft:diamond_block") {
      return;
    }

    Tell(player, "You placed a diamond block.");
  });

  BlockEvents.broken(function (event) {
    // event.block contains the broken block.
    // event.player contains the player when one caused the event.
  });

  BlockEvents.rightClicked(function (event) {
    // event.block contains the clicked block.
    // event.item contains the item used for the interaction.
  });

  // =============================================================
  // ENTITY EVENTS
  // =============================================================

  EntityEvents.spawned(function (event) {
    // event.entity contains the entity that entered the level.
    // Check its type before using methods belonging to a specific entity class.
  });

  // =============================================================
  // COMMANDS
  // =============================================================

  ServerEvents.commandRegistry(function (event) {
    let Commands = event.commands;

    event.register(
      Commands.literal("myscript")
        .executes(function (context) {
          let player = context.source.player;

          if (player == null) {
            return 0;
          }

          Tell(player, "My script is running!");
          return 1;
        })
        .then(
          Commands.literal("set_number").then(
            Commands.argument(
              "value",
              $IntegerArgumentType.integer(0),
            ).executes(function (context) {
              let player = context.source.player;

              if (player == null) {
                return 0;
              }

              let value = $IntegerArgumentType.getInteger(context, "value");

              if (!SetSavedNumber(player.server, value)) {
                Tell(player, "Invalid value.");
                return 0;
              }

              Tell(player, "Saved number: " + GetSavedNumber(player.server));
              return 1;
            }),
          ),
        ),
    );
  });
})();
