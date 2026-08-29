// GNL Cobblemon Daycare XP server script.

(function () {
  // =============================================================
  // JAVA IMPORTS
  // =============================================================

  // Minecraft chat messages.
  const $Component = Java.loadClass("net.minecraft.network.chat.Component");

  // Brigadier true/false command arguments.
  const $BoolArgumentType = Java.loadClass(
    "com.mojang.brigadier.arguments.BoolArgumentType",
  );

  // Brigadier integer command arguments.
  const $IntegerArgumentType = Java.loadClass(
    "com.mojang.brigadier.arguments.IntegerArgumentType",
  );

  // Main Cobblemon API and storage access.
  const $CobblemonApi = Java.loadClass("com.cobblemon.mod.common.Cobblemon");

  // Player-specific level cap from Radical Cobblemon Trainers.
  const $RctLevelUtils = Java.loadClass(
    "com.gitlab.srcmc.rctmod.api.utils.LevelUtils",
  );

  // Identifies XP as coming from this sidemod/script.
  const $SidemodExperienceSource = Java.loadClass(
    "com.cobblemon.mod.common.api.pokemon.experience.SidemodExperienceSource",
  );

  // =============================================================
  // CONSTANT CONFIGURATION
  // =============================================================

  // Name used in console messages.
  const LOG_TAG = "GNL_Daycare";

  // Prefix used to save persistent daycare configuration.
  const VARIABLE_PREFIX = "nogDaycareVariable_";

  // Prefix used to save debugger settings.
  const DEBUGGER_PREFIX = "nogDaycareDebugger_";

  // Identifies XP awarded by the daycare script.
  const DAYCARE_XP_SOURCE = new $SidemodExperienceSource("daycarexp");

  // =============================================================

  //Persistent daycare variable definitions:
  const DAYCARE_VARIABLES = {
    // XP generated whenever one distance milestone is completed.
    xp_per_milestone: {
      type: "integer",
      defaultValue: 1,
      minimum: 0,
    },

    // Blocks the player must cross to complete one milestone.
    blocks_per_milestone: {
      type: "integer",
      defaultValue: 1,
      minimum: 1,

      // Supports values saved under the previous variable name.
      legacyName: "blocks_per_xp_milestone",
    },

    // Seconds between movement and XP checks.
    check_interval_seconds: {
      type: "integer",
      defaultValue: 10,
      minimum: 1,
    },

    // Controls level-up and level-cap chat notifications.
    levelUpNotification: {
      type: "boolean",
      defaultValue: true,
    },
  };

  // =============================================================

  const DEBUGGERS = {
    // Displays movement and XP-distribution information.
    walk: {
      type: "boolean",
      defaultValue: false,
    },

    // Reserved for level-gained debugging.
    level_gained: {
      type: "boolean",
      defaultValue: false,
    },
  };

  // =============================================================
  // DAYCARE_RUNTIME_DATA
  // =============================================================

  // Temporary daycare data for the current server session.
  // None of these values are persistently saved.
  const DAYCARE_SESSION = {
    positionSampleTickCounter: 0,
    // Tick count since the last daycare interval.

    lastPositions: new Map(),
    // Previous measured position of each player.
    // Key: player UUID string
    // Value: { x: number, z: number }

    currentPositions: new Map(),
    // Most recently measured position of each player.
    // Key: player UUID string
    // Value: { x: number, z: number }

    distanceRemaindersByPlayer: new Map(),
    // Fractional distance that has not completed a milestone yet.
    // Key: player UUID string
    // Value: remaining distance as a number

    pendingXpByPlayer: new Map(),
    // Generated XP that has not been distributed yet.
    // Key: player UUID string
    // Value: pending integer XP

    pasturedPokemonIdsByPlayer: new Map(),
    // Temporary ordered list of tethered Pokemon UUIDs for each player.
    // Key: player UUID string
    // Value: array of Pokemon UUIDs

    pcChangeSubscriptions: new Map(),
    // Contains subscriptions that listen for changes to each player's PC
    // and execute a callback whenever a change occurs.
    // Players subscribe, and this stores the subscriptions.
    // Key: player UUID string
    // Value: array of observable subscriptions

    playersWithPausedXpProcessing: new Set(),
    // Player UUIDs whose XP processing is sleeping because
    // no currently pastured Pokemon can receive XP.
    // Value: player UUID string
    // Without this, we would need to make a bunch of scans that have already been made.

    trackedPokemonByPlayer: new Map(),
    // Temporary tracker information selected with /daycarexp track.
    // Key: player UUID string
    // Value: tracked Pokemon UUID, list signature, and starting XP progress
  };

  // =============================================================
  // SMALL REUSABLE FUNCTIONS
  // =============================================================

  function GetPlayerKey(player) {
    return String(player.uuid);
  }

  function Tell(player, message) {
    player.sendSystemMessage($Component.literal(String(message)));
  }

  function TellAllPlayers(server, message) {
    // Get an iterator containing every online player.
    let players = server.getPlayerList().getPlayers().iterator();

    // Send the message separately to every online player.
    while (players.hasNext()) {
      let player = players.next();

      Tell(player, message);
    }
  }

  function SecondsToTicks(seconds) {
    return Math.floor(Number(seconds) * 20);
  }

  function GetDaycareVariablePersistentKey(variableName) {
    return VARIABLE_PREFIX + variableName;
  }

  function GetDaycareVariable(server, variableName) {
    // Find the variable's definition inside DAYCARE_VARIABLES.
    let definition = DAYCARE_VARIABLES[variableName];

    // Stop if the requested variable does not exist in DAYCARE_VARIABLES.
    if (definition == null) {
      return null;
    }
    // Get Minecraft's persistent server-data container.
    // Values stored here survive when server restarts.
    let savedData = server.persistentData;
    let persistentKey = GetDaycareVariablePersistentKey(variableName);

    // Migrate a value saved using the previous variable name.
    if (!savedData.contains(persistentKey) && definition.legacyName != null) {
      let legacyKey = GetDaycareVariablePersistentKey(definition.legacyName);

      if (savedData.contains(legacyKey)) {
        savedData.putInt(persistentKey, savedData.getInt(legacyKey));
      }
    }

    // Create the default value when it has never been saved.
    if (!savedData.contains(persistentKey)) {
      if (definition.type === "boolean") {
        savedData.putBoolean(persistentKey, definition.defaultValue);
      } else {
        savedData.putInt(persistentKey, definition.defaultValue);
      }
    }

    if (definition.type === "boolean") {
      return savedData.getBoolean(persistentKey);
    }

    let value = Number(savedData.getInt(persistentKey));

    // Repair invalid saved numeric values.
    if (!isFinite(value) || value < definition.minimum) {
      value = definition.defaultValue;
      savedData.putInt(persistentKey, value);
    }

    return Math.floor(value);
  }

  function SetDaycareVariable(server, variableName, newValue) {
    let definition = DAYCARE_VARIABLES[variableName];

    if (definition == null) {
      return false;
    }

    let persistentKey = GetDaycareVariablePersistentKey(variableName);

    if (definition.type === "boolean") {
      server.persistentData.putBoolean(persistentKey, Boolean(newValue));

      return true;
    }

    let integerValue = Math.floor(Number(newValue));

    if (!isFinite(integerValue) || integerValue < definition.minimum) {
      return false;
    }

    server.persistentData.putInt(persistentKey, integerValue);

    return true;
  }

  function GetDebuggerValue(server, debuggerName) {
    let definition = DEBUGGERS[debuggerName];

    if (definition == null) {
      return false;
    }

    let persistentKey = DEBUGGER_PREFIX + debuggerName;

    if (!server.persistentData.contains(persistentKey)) {
      server.persistentData.putBoolean(persistentKey, definition.defaultValue);
    }

    return server.persistentData.getBoolean(persistentKey);
  }

  function SetDebuggerValue(server, debuggerName, enabled) {
    if (DEBUGGERS[debuggerName] == null) {
      return false;
    }

    server.persistentData.putBoolean(
      DEBUGGER_PREFIX + debuggerName,
      Boolean(enabled),
    );

    return true;
  }

  // =============================================================
  // DAYCARE SYSTEM FUNCTIONS
  // =============================================================
  //
  // These functions contain the main daycare behavior.
  //
  // Recommended dependency direction:
  //
  // Event handlers
  //     ↓
  // High-level daycare functions
  //     ↓
  // Focused storage, movement, tracking, and XP functions
  //
  // Event handlers should remain small. They should call the
  // appropriate high-level function from this section.

  // -------------------------------------------------------------
  // COBBLEMON PC STORAGE
  // -------------------------------------------------------------

  // Get every Cobblemon PC store associated with one player.
  //PCSTORE refers to the collection of pokemons a player has in their PC, not the daycare.
  function GetPlayerPcStores(player) {
    // Ask Cobblemon's storage manager for the PCSTORE associated
    // with this player's UUID.
    let storeIterator = $CobblemonApi.INSTANCE.getStorage()
      .getPCs(player.uuid, player.registryAccess())
      .iterator();

    // Create a normal JavaScript array for the store references.
    let playerPcStores = [];

    // Move every PC store reference from the Java iterator
    // into the JavaScript array.
    while (storeIterator.hasNext()) {
      let pcStore = storeIterator.next();

      playerPcStores.push(pcStore);
    }

    // Return references to the existing PC stores.
    //
    // This does not copy, recreate, add, or remove any Pokemon.
    return playerPcStores;
  }

  // Find an existing Pokemon in the player's PC stores using its UUID.
  function FindPokemonInPlayerPcStores(player, pokemonUuid) {
    // Get every PCStore associated with this player.
    let playerPcStores = GetPlayerPcStores(player);

    // Search each PCStore until the Pokemon UUID is found.
    for (let storeIndex = 0; storeIndex < playerPcStores.length; storeIndex++) {
      // Get the current PCStore reference.
      let pcStore = playerPcStores[storeIndex];

      // Ask this store for the Pokemon with the supplied UUID.
      let pokemon = pcStore.get(pokemonUuid);

      // Stop searching as soon as one store returns the Pokemon.
      if (pokemon != null) {
        return pokemon;
      }
    }

    // None of the player's PC stores contained this UUID.
    return null;
  }

  // -------------------------------------------------------------
  // TEMPORARY PASTURE LIST
  // -------------------------------------------------------------

  // Scan the player's PC stores and create their temporary ordered
  // list of tethered Pokemon UUIDs.
  function RefreshPasturedPokemonIds(player) {
    // TODO
  }

  // Begin listening for changes to the player's PC stores.
  function SubscribePlayerToPcChanges(player) {
    // TODO
  }

  // Stop every PC-change listener belonging to one player.
  function UnsubscribePlayerFromPcChanges(playerKey) {
    // TODO
  }

  // -------------------------------------------------------------
  // PLAYER LEVEL CAP AND ELIGIBILITY
  // -------------------------------------------------------------

  // Read the player's current progression-based level cap.
  function GetPlayerLevelCap(player) {
    // TODO
  }

  // Resolve the temporary Pasture list and separate eligible and
  // level-capped Pokemon.
  function GetPasturedPokemonStats(player) {
    // TODO
  }

  // -------------------------------------------------------------
  // PLAYER MOVEMENT
  // -------------------------------------------------------------

  // Read the player's current horizontal X/Z position.
  function GetCurrentHorizontalPosition(player) {
    // TODO
  }

  // Measure the distance between the previous and current position.
  function MeasurePlayerDistance(player) {
    // TODO
  }

  // Convert completed distance milestones into pending integer XP
  // while preserving incomplete distance.
  function GeneratePendingXpFromDistance(server, playerKey, measuredDistance) {
    // TODO
  }

  // -------------------------------------------------------------
  // XP DISTRIBUTION
  // -------------------------------------------------------------

  // Remove a Pokemon UUID only from this script's temporary
  // recipient list. This must never modify Cobblemon storage.
  function RemovePokemonFromLocalRecipientList(playerKey, pokemonUuid) {
    // TODO
  }

  // Give a cap-safe integer XP amount to one pastured Pokemon.
  function TryGiveXpToPasturedPokemon(
    server,
    player,
    pokemonUuid,
    requestedXp,
  ) {
    // TODO
  }

  // Distribute complete equal integer XP batches among all eligible
  // pastured Pokemon while preserving the remainder.
  function DistributePendingXp(server, player) {
    // TODO
  }

  // -------------------------------------------------------------
  // TEMPORARY XP TRACKER
  // -------------------------------------------------------------

  // Convert the ordered temporary Pokemon UUID list into a value
  // that can be compared after a PC change.
  function CreatePasturedListSignature(pokemonIds) {
    // TODO
  }

  // Read one Pokemon's current level and XP progress.
  function GetPokemonXpProgress(pokemon) {
    // TODO
  }

  // Format an XP-progress object for a chat message.
  function FormatPokemonXpProgress(progress) {
    // TODO
  }

  // Start tracking the Pokemon at a particular temporary-list index.
  function StartPokemonXpTracker(player, listIndex) {
    // TODO
  }

  // Deactivate the current tracker belonging to one player.
  function DeactivatePokemonXpTracker(player, notificationMessage) {
    // TODO
  }

  // Display tracker progress when the tracked Pokemon receives
  // daycare XP.
  function UpdatePokemonXpTracker(player, experienceBeforeDistribution) {
    // TODO
  }

  // -------------------------------------------------------------
  // DEBUG OUTPUT
  // -------------------------------------------------------------

  // Display the walking and XP-distribution debugger message.
  function DisplayWalkDebugger(server, player, intervalResult) {
    // TODO
  }

  // -------------------------------------------------------------
  // HIGH-LEVEL PLAYER PROCESSING
  // -------------------------------------------------------------

  // Run the complete daycare operation for one player.
  //
  // This is the function called by ServerEvents.tick after the
  // configured interval has passed.
  function ProcessDaycareInterval(server, player) {
    // TODO:
    //
    // 1. Measure the player's movement.
    // 2. Stop early if XP processing is paused.
    // 3. Resolve eligible pastured Pokemon.
    // 4. Convert completed distance milestones into pending XP.
    // 5. Record the tracked Pokemon's experience before distribution.
    // 6. Distribute complete equal XP batches.
    // 7. Update the temporary XP tracker.
    // 8. Display debugger information when enabled.
  }

  // =============================================================
  // SERVER LOAD AND UNLOAD
  // =============================================================

  ServerEvents.loaded(function (event) {
    console.info("[" + LOG_TAG + "] Server script loaded.");

    // Get every declared persistent daycare variable name.
    let variableNames = Object.keys(DAYCARE_VARIABLES);
    // Read every variable once.

    // GetDaycareVariable creates its default persistent value
    // when the variable has never been saved before.
    for (let index = 0; index < variableNames.length; index++) {
      GetDaycareVariable(event.server, variableNames[index]);
    }

    // Get every declared debugger name.
    let debuggerNames = Object.keys(DEBUGGERS);

    // Read every debugger once, creating its default saved value
    // when necessary.
    for (let index = 0; index < debuggerNames.length; index++) {
      GetDebuggerValue(event.server, debuggerNames[index]);
    }

    // Usually no players are online this early, but checking is safe.
    let players = event.server.getPlayerList().getPlayers().iterator();

    while (players.hasNext()) {
      let player = players.next();

      // We will implement this function in the PC/Pasture section.
      //SubscribePlayerToPcChanges(player);
    }
  });

  ServerEvents.unloaded(function () {
    // Visit the arrays of PC-change subscriptions belonging
    // to every player.
    DAYCARE_SESSION.pcChangeSubscriptions.forEach(function (subscriptions) {
      // Unsubscribe every stored listener handle.
      for (let index = 0; index < subscriptions.length; index++) {
        subscriptions[index].unsubscribe();
      }
    });

    // Remove all stored PC-listener handles.
    DAYCARE_SESSION.pcChangeSubscriptions.clear();

    // Remove all temporary player positions.
    DAYCARE_SESSION.lastPositions.clear();
    DAYCARE_SESSION.currentPositions.clear();

    // Remove incomplete distance values.
    DAYCARE_SESSION.distanceRemaindersByPlayer.clear();

    // Remove undistributed session XP.
    DAYCARE_SESSION.pendingXpByPlayer.clear();

    // Remove temporary Pasture Pokemon UUID lists.
    DAYCARE_SESSION.pasturedPokemonIdsByPlayer.clear();

    // Remove all paused-processing flags.
    DAYCARE_SESSION.playersWithPausedXpProcessing.clear();

    // Remove temporary XP trackers.
    DAYCARE_SESSION.trackedPokemonByPlayer.clear();

    // Reset the shared interval counter.
    DAYCARE_SESSION.positionSampleTickCounter = 0;

    console.info("[" + LOG_TAG + "] Temporary session data cleared.");
  });

  // =============================================================
  // PLAYER LOGIN AND LOGOUT
  // =============================================================

  PlayerEvents.loggedIn(function (event) {
    let player = event.player;

    // Create the player's temporary Pasture list and begin
    // listening for changes to their Cobblemon PC.
    SubscribePlayerToPcChanges(player);

    // Send this message only to the player who joined.
    Tell(player, "GNL Daycare script online.");
  });

  PlayerEvents.loggedOut(function (event) {
    let player = event.player;
    let playerKey = GetPlayerKey(player);

    // Stop the PC-change callbacks associated with this player.
    UnsubscribePlayerFromPcChanges(playerKey);

    // Remove this player's temporary session information.
    DAYCARE_SESSION.lastPositions.delete(playerKey);
    DAYCARE_SESSION.currentPositions.delete(playerKey);
    DAYCARE_SESSION.distanceRemaindersByPlayer.delete(playerKey);
    DAYCARE_SESSION.pendingXpByPlayer.delete(playerKey);
    DAYCARE_SESSION.pasturedPokemonIdsByPlayer.delete(playerKey);
    DAYCARE_SESSION.playersWithPausedXpProcessing.delete(playerKey);
    DAYCARE_SESSION.trackedPokemonByPlayer.delete(playerKey);
  });

  // =============================================================
  // REPEATING SERVER TICK
  // =============================================================

  ServerEvents.tick(function (event) {
    // This event executes once every server tick.
    DAYCARE_SESSION.positionSampleTickCounter++;

    // Read the currently configured interval in seconds.
    let intervalSeconds = GetDaycareVariable(
      event.server,
      "check_interval_seconds",
    );

    // Convert the configured seconds into Minecraft ticks.
    let intervalTicks = SecondsToTicks(intervalSeconds);

    // Wait until enough ticks have passed.
    if (DAYCARE_SESSION.positionSampleTickCounter < intervalTicks) {
      return;
    }

    // Begin counting toward the next interval.
    DAYCARE_SESSION.positionSampleTickCounter = 0;

    // Get every player currently online.
    let players = event.server.getPlayerList().getPlayers().iterator();

    // Process each player separately.
    while (players.hasNext()) {
      let player = players.next();

      // This function will later:
      // - Measure the player's movement.
      // - Generate milestone XP.
      // - Find eligible pastured Pokemon.
      // - Distribute pending XP.
      // - Produce debugger/tracker messages.
      ProcessDaycareInterval(event.server, player);
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
