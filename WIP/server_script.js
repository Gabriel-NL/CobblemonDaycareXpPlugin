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
    // Get the string used as this player's map key.
    let playerKey = GetPlayerKey(player);

    // Create a new replacement list.
    // Replacing the old list ensures that Pokemon removed from
    // Pastures disappear from the local list.
    let pasturedPokemonIds = [];

    // Prevent the same Pokemon UUID from appearing more than once.
    let observedPokemonIds = new Set();

    // Get all PCStore objects associated with this player.
    let playerPcStores = GetPlayerPcStores(player);

    // Visit each PCStore.
    for (let storeIndex = 0; storeIndex < playerPcStores.length; storeIndex++) {
      let pcStore = playerPcStores[storeIndex];

      // Get a Java iterator containing the Pokemon in this PCStore.
      let pokemonIterator = pcStore.iterator();

      // Visit every stored Pokemon.
      while (pokemonIterator.hasNext()) {
        let pokemon = pokemonIterator.next();

        // Read the Pokemon's Pasture tethering identifier.
        let tetheringId = pokemon.getTetheringId();

        // A null tethering ID means the Pokemon is not currently
        // assigned to a Pasture.
        if (tetheringId == null) {
          continue;
        }

        // Read the Pokemon's stable UUID.
        let pokemonUuid = pokemon.getUuid();

        // Convert the UUID to text only for duplicate detection.
        let pokemonKey = String(pokemonUuid);

        // Ignore this UUID if another store already returned it.
        if (observedPokemonIds.has(pokemonKey)) {
          continue;
        }

        // Remember that this UUID has been included.
        observedPokemonIds.add(pokemonKey);

        // Store the original UUID object in the ordered local list.
        pasturedPokemonIds.push(pokemonUuid);
      }
    }

    // Replace only this player's temporary local list.
    //
    // This does not add, remove, or modify any Pokemon in Cobblemon.
    DAYCARE_SESSION.pasturedPokemonIdsByPlayer.set(
      playerKey,
      pasturedPokemonIds,
    );

    // Return the new list so a caller can inspect or compare it.
    return pasturedPokemonIds;
  }

  // Create the player's initial temporary Pasture list and begin
  // listening for changes to their Cobblemon PC stores.
  function SubscribePlayerToPcChanges(player) {
    // Get the string used as this player's map key.
    let playerKey = GetPlayerKey(player);

    // Remove any previous subscriptions before creating new ones.
    //
    // This prevents duplicate callbacks if this function is called
    // more than once for the same player.
    UnsubscribePlayerFromPcChanges(playerKey);

    // Build the player's initial temporary Pasture UUID list.
    RefreshPasturedPokemonIds(player);

    // Get every PCStore associated with this player.
    let playerPcStores = GetPlayerPcStores(player);

    // Store the subscription handles created for this player.
    let playerSubscriptions = [];

    // Subscribe to changes from every associated PCStore.
    for (let storeIndex = 0; storeIndex < playerPcStores.length; storeIndex++) {
      let pcStore = playerPcStores[storeIndex];

      // Get the observable that reports changes to this PCStore.
      let pcChangeObservable = pcStore.getPcChangeObservable();

      // Register a callback that Cobblemon executes whenever this
      // PCStore reports a change.
      let subscription = pcChangeObservable.subscribe(function () {
        // A PC change means the player's eligibility may have
        // changed, so allow XP processing to run again.
        DAYCARE_SESSION.playersWithPausedXpProcessing.delete(playerKey);

        // Rebuild only this player's temporary Pasture list.
        let refreshedPokemonIds = RefreshPasturedPokemonIds(player);

        // Check whether this player currently has an active
        // temporary XP tracker.
        let tracker = DAYCARE_SESSION.trackedPokemonByPlayer.get(playerKey);

        // If no tracker is active, no comparison is needed.
        if (tracker == null) {
          return;
        }

        // Convert the refreshed list into a comparable signature.
        let refreshedListSignature =
          CreatePasturedListSignature(refreshedPokemonIds);

        // Keep tracking when the ordered Pasture list is unchanged.
        if (refreshedListSignature === tracker.listSignature) {
          return;
        }

        // The temporary ordered Pasture list changed, so the index
        // originally selected by the player is no longer reliable.
        DeactivatePokemonXpTracker(
          player,
          "Pastured Pokemon list changed. " + "Deactivating tracker.",
        );
      });

      // Retain the subscription handle so it can later be stopped
      // with subscription.unsubscribe().
      playerSubscriptions.push(subscription);
    }

    // Save all PC-listener handles under this player's UUID.
    DAYCARE_SESSION.pcChangeSubscriptions.set(playerKey, playerSubscriptions);
  }

  // Stop every PC-change listener belonging to one player.
  function UnsubscribePlayerFromPcChanges(playerKey) {
    // Get the array of subscription handles saved for this player.
    let playerSubscriptions =
      DAYCARE_SESSION.pcChangeSubscriptions.get(playerKey);

    // Nothing needs to be stopped if the player has no saved
    // subscriptions.
    if (playerSubscriptions == null) {
      return;
    }

    // Unsubscribe every PCStore listener belonging to the player.
    for (let index = 0; index < playerSubscriptions.length; index++) {
      let subscription = playerSubscriptions[index];

      subscription.unsubscribe();
    }

    // Remove the inactive handles from the session map.
    DAYCARE_SESSION.pcChangeSubscriptions.delete(playerKey);
  }

  // -------------------------------------------------------------
  // PLAYER LEVEL CAP AND ELIGIBILITY
  // -------------------------------------------------------------

  // Read the player's current progression-based level cap.
  function GetPlayerLevelCap(player) {
    // Ask Radical Cobblemon Trainers for the level cap currently
    // assigned to this specific player.
    let levelCap = $RctLevelUtils.levelCap(player);

    // Convert the returned Java numeric value into a normal
    // JavaScript number.
    return Number(levelCap);
  }

  // Resolve the player's temporary Pasture list and separate
  // eligible and level-capped Pokemon.
  function GetPasturedPokemonStats(player) {
    // Get the key used for this player's temporary values.
    let playerKey = GetPlayerKey(player);

    // Use an empty array if the list has not been initialized yet.
    let pasturedPokemonIds =
      DAYCARE_SESSION.pasturedPokemonIdsByPlayer.get(playerKey) || [];

    // Read the current progression cap for this specific player.
    let currentLevelCap = GetPlayerLevelCap(player);

    // Prepare the information that will be returned.
    let stats = {
      // Number of valid pastured Pokemon below the player's cap.
      eligiblePokemonCount: 0,

      // Number of all valid and currently tethered Pokemon.
      totalPokemonCount: 0,

      // Number of pastured Pokemon that cannot receive XP.
      cappedPokemonCount: 0,

      // The player's current progression-based cap.
      currentLevelCap: currentLevelCap,

      // UUIDs belonging to Pokemon that may receive XP.
      eligiblePokemonIds: [],

      // UUIDs belonging to Pokemon that are already capped.
      cappedPokemonIds: [],
    };

    // Prevent duplicate UUIDs from being counted twice.
    let observedPokemonIds = new Set();

    // Inspect every UUID in the temporary Pasture list.
    for (let index = 0; index < pasturedPokemonIds.length; index++) {
      // Read the next stored UUID.
      let pokemonUuid = pasturedPokemonIds[index];

      // Convert the UUID into text for duplicate comparison.
      let pokemonKey = String(pokemonUuid);

      // Ignore this UUID if it was already processed.
      if (observedPokemonIds.has(pokemonKey)) {
        continue;
      }

      // Remember that this UUID has now been processed.
      observedPokemonIds.add(pokemonKey);

      // Resolve the current Pokemon object from the player's
      // PCStore objects.
      let pokemon = FindPokemonInPlayerPcStores(player, pokemonUuid);

      // Ignore UUIDs that can no longer be resolved.
      if (pokemon == null) {
        continue;
      }

      // Verify that the Pokemon is still assigned to a Pasture.
      //
      // The temporary list could be slightly out of date if a PC
      // change occurred while this interval was being processed.
      if (pokemon.getTetheringId() == null) {
        continue;
      }

      // This is a valid currently tethered Pokemon, so include it
      // in the total count.
      stats.totalPokemonCount++;

      // Read the Pokemon's current level.
      let pokemonLevel = Number(pokemon.getLevel());

      // A Pokemon is capped when:
      //
      // 1. Its level reached this player's progression cap, or
      // 2. Cobblemon reports that it cannot level any further.
      let isLevelCapped =
        pokemonLevel >= currentLevelCap || !pokemon.canLevelUpFurther();

      if (isLevelCapped) {
        // Count the Pokemon as capped.
        stats.cappedPokemonCount++;

        // Store its UUID separately.
        stats.cappedPokemonIds.push(pokemonUuid);

        // Do not include it in the eligible recipient list.
        continue;
      }

      // This Pokemon may currently receive daycare XP.
      stats.eligiblePokemonCount++;

      // Store its UUID in the eligible-recipient list.
      stats.eligiblePokemonIds.push(pokemonUuid);
    }

    // Return all collected counts and UUID lists.
    return stats;
  }

  // -------------------------------------------------------------
  // PLAYER MOVEMENT
  // -------------------------------------------------------------

  // Read the player's current horizontal X/Z position.
  function GetCurrentHorizontalPosition(player) {
    // Read the player's current X coordinate.
    let positionX = Number(player.getX());

    // Read the player's current Z coordinate.
    let positionZ = Number(player.getZ());

    // Return only the horizontal coordinates.
    //
    // The Y coordinate is intentionally ignored because vertical
    // movement should not count toward walked daycare distance.
    return {
      x: positionX,
      z: positionZ,
    };
  }

  // Measure the horizontal distance between the player's previous
  // sampled position and their current position.
  function MeasurePlayerDistance(player) {
    // Get the key used for this player's temporary values.
    let playerKey = GetPlayerKey(player);

    // Read the player's current horizontal X/Z position.
    let currentPosition = GetCurrentHorizontalPosition(player);

    // Save the newest sampled position.
    DAYCARE_SESSION.currentPositions.set(playerKey, currentPosition);

    // Read the position saved during the previous interval.
    let previousPosition = DAYCARE_SESSION.lastPositions.get(playerKey);

    // The first measurement has no previous position available.
    //
    // Use the current position as the initial baseline and return
    // zero so joining the server does not generate distance.
    if (previousPosition == null) {
      DAYCARE_SESSION.lastPositions.set(playerKey, currentPosition);

      return 0;
    }

    // Calculate how far the player moved along the X axis.
    let differenceX = currentPosition.x - previousPosition.x;

    // Calculate how far the player moved along the Z axis.
    let differenceZ = currentPosition.z - previousPosition.z;

    // Use the Pythagorean theorem to calculate the straight-line
    // horizontal distance between both sampled positions.
    let measuredDistance = Math.sqrt(
      differenceX * differenceX + differenceZ * differenceZ,
    );

    // Move the current position into the previous-position map so
    // it becomes the baseline for the next interval.
    DAYCARE_SESSION.lastPositions.set(playerKey, currentPosition);

    // Return the measured horizontal distance in blocks.
    return measuredDistance;
  }

  // Convert completed distance milestones into pending integer XP
  // while preserving incomplete distance.
  function GeneratePendingXpFromDistance(server, playerKey, measuredDistance) {
    // Convert the measured distance into a JavaScript number.
    let safeMeasuredDistance = Number(measuredDistance);

    // Ignore invalid or negative distance values.
    if (!isFinite(safeMeasuredDistance) || safeMeasuredDistance < 0) {
      return 0;
    }

    // Read the fractional distance preserved from previous intervals.
    //
    // Use zero if this player does not have a saved remainder yet.
    let previousDistanceRemainder = Number(
      DAYCARE_SESSION.distanceRemaindersByPlayer.get(playerKey) || 0,
    );

    // Combine the previous remainder with the newly measured distance.
    let availableDistance = previousDistanceRemainder + safeMeasuredDistance;

    // Read how many blocks are required to complete one XP milestone.
    let blocksPerMilestone = GetDaycareVariable(server, "blocks_per_milestone");

    // Determine how many complete milestones fit inside the
    // available distance.
    //
    // Math.floor ensures that only complete integer milestones count.
    let completedMilestones = Math.floor(
      availableDistance / blocksPerMilestone,
    );

    // Remove only the distance consumed by complete milestones.
    //
    // Any incomplete fractional distance remains available for the
    // next interval.
    let newDistanceRemainder =
      availableDistance - completedMilestones * blocksPerMilestone;

    // Save the incomplete distance for the next calculation.
    DAYCARE_SESSION.distanceRemaindersByPlayer.set(
      playerKey,
      newDistanceRemainder,
    );

    // Read how much XP one completed milestone generates.
    let xpPerMilestone = GetDaycareVariable(server, "xp_per_milestone");

    // Generate an integer amount of XP.
    let generatedXp = completedMilestones * xpPerMilestone;

    // Read XP previously generated but not distributed.
    let previousPendingXp = Number(
      DAYCARE_SESSION.pendingXpByPlayer.get(playerKey) || 0,
    );

    // Add the newly generated XP to the player's pending balance.
    DAYCARE_SESSION.pendingXpByPlayer.set(
      playerKey,
      previousPendingXp + generatedXp,
    );

    // Return only the XP generated during this calculation.
    return generatedXp;
  }

  // -------------------------------------------------------------
  // XP DISTRIBUTION
  // -------------------------------------------------------------

  // Remove one Pokemon UUID from the temporary recipient array used
  // only during the current XP-distribution operation.
  function RemovePokemonFromLocalRecipientList(
    recipientPokemonIds,
    pokemonUuid,
  ) {
    // Convert the target UUID into text for reliable comparison.
    let targetPokemonKey = String(pokemonUuid);

    // Iterate backwards so removing an entry does not cause the
    // following array indexes to be skipped.
    for (let index = recipientPokemonIds.length - 1; index >= 0; index--) {
      // Convert the current UUID into text for comparison.
      let currentPokemonKey = String(recipientPokemonIds[index]);

      // Keep entries that do not match the target UUID.
      if (currentPokemonKey !== targetPokemonKey) {
        continue;
      }

      // Remove exactly one matching UUID from the temporary array.
      recipientPokemonIds.splice(index, 1);
    }
  }

  // Resolve one pastured Pokemon and give it a cap-safe integer
  // amount of daycare XP.
  function TryGiveXpToPasturedPokemon(
    server,
    player,
    pokemonUuid,
    requestedXp,
  ) {
    // Resolve the current Pokemon object through the player's
    // PCStore objects.
    let pokemon = FindPokemonInPlayerPcStores(player, pokemonUuid);

    // The UUID can no longer be used if the Pokemon is missing.
    if (pokemon == null) {
      return {
        acceptedXp: 0,
        capped: false,
        blocked: true,
      };
    }

    // Verify that the Pokemon is still assigned to a Pasture.
    if (pokemon.getTetheringId() == null) {
      return {
        acceptedXp: 0,
        capped: false,
        blocked: true,
      };
    }

    // Convert the requested XP into a positive integer.
    let safeRequestedXp = Math.floor(Number(requestedXp));

    // Reject invalid, zero, or negative requests.
    if (!isFinite(safeRequestedXp) || safeRequestedXp <= 0) {
      return {
        acceptedXp: 0,
        capped: false,
        blocked: true,
      };
    }

    // Read this player's current progression-based level cap.
    let currentLevelCap = GetPlayerLevelCap(player);

    // Read the Pokemon's current level.
    let oldLevel = Number(pokemon.getLevel());

    // The Pokemon cannot receive XP if it has already reached the
    // player's current cap or Cobblemon's absolute level limit.
    if (oldLevel >= currentLevelCap || !pokemon.canLevelUpFurther()) {
      return {
        acceptedXp: 0,
        capped: true,
        blocked: false,
      };
    }

    // Ask Cobblemon how much experience this Pokemon still requires
    // to reach the player's current level cap.
    let xpUntilPlayerCap = Number(
      pokemon.getExperienceToLevel(currentLevelCap),
    );

    // Prevent the daycare from giving more XP than the Pokemon can
    // accept before reaching the player's cap.
    let cappedXpRequest = Math.min(safeRequestedXp, xpUntilPlayerCap);

    // Treat a non-positive allowance as already capped.
    if (cappedXpRequest <= 0) {
      return {
        acceptedXp: 0,
        capped: true,
        blocked: false,
      };
    }

    // Record total experience before applying daycare XP.
    let oldExperience = Number(pokemon.getExperience());

    // =============================================================
    // ACTUAL XP APPLICATION
    // =============================================================

    pokemon.addExperience(DAYCARE_XP_SOURCE, cappedXpRequest);

    // =============================================================

    // Read the Pokemon's experience and level after Cobblemon
    // processes the XP request.
    let newExperience = Number(pokemon.getExperience());

    let newLevel = Number(pokemon.getLevel());

    // Count only XP that Cobblemon demonstrably accepted.
    let acceptedXp = Math.max(0, newExperience - oldExperience);

    // Read the cap again in case another system changed the player's
    // progression during XP processing.
    let updatedLevelCap = GetPlayerLevelCap(player);

    // Determine whether the Pokemon must leave the recipient array.
    let reachedLevelCap =
      newLevel >= updatedLevelCap || !pokemon.canLevelUpFurther();

    // Read the persistent notification preference.
    let notificationsEnabled = GetDaycareVariable(
      server,
      "levelUpNotification",
    );

    // Send one message for every level gained during this XP request.
    if (notificationsEnabled && newLevel > oldLevel) {
      for (
        let reachedLevel = oldLevel + 1;
        reachedLevel <= newLevel;
        reachedLevel++
      ) {
        Tell(
          player,
          pokemon.getDisplayName(false).getString() +
            " reached level " +
            reachedLevel +
            ".",
        );
      }
    }

    // Send an additional message when the Pokemon newly reaches the
    // player's current progression cap.
    if (notificationsEnabled && oldLevel < updatedLevelCap && reachedLevelCap) {
      Tell(
        player,
        pokemon.getDisplayName(false).getString() +
          " reached your current level cap (" +
          newLevel +
          ").",
      );
    }

    // Return the measured result to the distribution function.
    return {
      // XP that Cobblemon actually accepted.
      acceptedXp: acceptedXp,

      // True when this Pokemon should be removed from the temporary
      // recipient array.
      capped: reachedLevelCap,

      // True when XP was refused for a reason other than reaching
      // the level cap.
      blocked: acceptedXp <= 0 && !reachedLevelCap,
    };
  }

  // Distribute complete equal integer XP batches among all eligible
  // pastured Pokemon while preserving undistributable XP.
  function DistributePendingXp(server, player) {
    // Get the key used for this player's temporary values.
    let playerKey = GetPlayerKey(player);

    // Classify the player's currently pastured Pokemon.
    let stats = GetPasturedPokemonStats(player);

    // Create a separate recipient array for this distribution.
    //
    // slice() ensures that removing a recipient from this array
    // does not modify the complete temporary Pasture list.
    let recipientPokemonIds = stats.eligiblePokemonIds.slice();

    // No Pokemon can currently receive XP.
    if (recipientPokemonIds.length === 0) {
      // Remember that repeatedly checking this player is currently
      // unnecessary.
      DAYCARE_SESSION.playersWithPausedXpProcessing.add(playerKey);

      return 0;
    }

    // Keep application order stable between intervals.
    recipientPokemonIds.sort(function (firstPokemonUuid, secondPokemonUuid) {
      return String(firstPokemonUuid).localeCompare(String(secondPokemonUuid));
    });

    // Track how much XP Cobblemon actually accepted during this
    // complete distribution operation.
    let totalAcceptedXp = 0;

    // Continue while at least one recipient remains.
    while (recipientPokemonIds.length > 0) {
      // Read the player's current undistributed XP balance.
      //
      // This is read again every pass because accepted XP removes
      // values from the balance immediately.
      let pendingXp = Number(
        DAYCARE_SESSION.pendingXpByPlayer.get(playerKey) || 0,
      );

      // Calculate an equal integer share for every current recipient.
      let xpPerPokemon = Math.floor(pendingXp / recipientPokemonIds.length);

      // Stop if there is not enough XP to give every recipient at
      // least one equal integer XP.
      //
      // The complete pending balance remains preserved.
      if (xpPerPokemon <= 0) {
        break;
      }

      // Copy the current recipient list because recipients may be
      // removed from recipientPokemonIds during this pass.
      let recipientsForCurrentPass = recipientPokemonIds.slice();

      // Process every recipient that was present when this equal
      // share was calculated.
      for (let index = 0; index < recipientsForCurrentPass.length; index++) {
        let pokemonUuid = recipientsForCurrentPass[index];

        // Attempt to give this recipient the calculated equal share.
        let result = TryGiveXpToPasturedPokemon(
          server,
          player,
          pokemonUuid,
          xpPerPokemon,
        );

        // Remove only XP that Cobblemon demonstrably accepted.
        if (result.acceptedXp > 0) {
          let currentPendingXp = Number(
            DAYCARE_SESSION.pendingXpByPlayer.get(playerKey) || 0,
          );

          DAYCARE_SESSION.pendingXpByPlayer.set(
            playerKey,
            Math.max(0, currentPendingXp - result.acceptedXp),
          );

          totalAcceptedXp += result.acceptedXp;
        }

        // A capped Pokemon must not participate in another pass.
        if (result.capped) {
          RemovePokemonFromLocalRecipientList(recipientPokemonIds, pokemonUuid);

          continue;
        }

        // A blocked Pokemon cannot safely participate in another
        // pass during this interval.
        if (result.blocked) {
          RemovePokemonFromLocalRecipientList(recipientPokemonIds, pokemonUuid);

          continue;
        }

        // If Cobblemon accepted less than the complete equal share,
        // remove this recipient from later passes to avoid repeatedly
        // requesting XP from it during the same interval.
        if (result.acceptedXp !== xpPerPokemon) {
          RemovePokemonFromLocalRecipientList(recipientPokemonIds, pokemonUuid);
        }
      }
    }

    // If every recipient became capped, missing, or blocked, pause
    // processing until this player's PC reports another change.
    if (recipientPokemonIds.length === 0) {
      DAYCARE_SESSION.playersWithPausedXpProcessing.add(playerKey);
    }

    // Return only XP that was successfully applied.
    return totalAcceptedXp;
  }

  // -------------------------------------------------------------
  // TEMPORARY XP TRACKER
  // -------------------------------------------------------------

  // Convert an ordered array of Pokemon UUIDs into one comparable
  // string representing the complete temporary Pasture list.
  function CreatePasturedListSignature(pokemonIds) {
    // Create an array that will contain text versions of the UUIDs.
    let pokemonIdStrings = [];

    // Convert every UUID into a JavaScript string while preserving
    // the original array order.
    for (let index = 0; index < pokemonIds.length; index++) {
      pokemonIdStrings.push(String(pokemonIds[index]));
    }

    // Join the UUID strings with a separator.
    //
    // Example:
    // uuid-1|uuid-2|uuid-3
    return pokemonIdStrings.join("|");
  }

  // Read one Pokemon's current level and XP progress.
  // Read one Pokemon's current level and total XP progress toward
  // its next level.
  function GetPokemonXpProgress(pokemon) {
    // Read the Pokemon's current level.
    let currentLevel = Number(pokemon.getLevel());

    // Read the Pokemon's current total accumulated experience.
    let currentExperience = Number(pokemon.getExperience());

    // Start with the current experience as a safe fallback.
    //
    // If the Pokemon cannot level further, the displayed result will
    // become currentExperience/currentExperience.
    let totalExperienceForNextLevel = currentExperience;

    try {
      // Ask Cobblemon how much additional XP is required to reach
      // the next level from the Pokemon's current experience.
      let remainingExperience = Number(
        pokemon.getExperienceToLevel(currentLevel + 1),
      );

      // Protect the progress object from an invalid API result.
      if (isFinite(remainingExperience) && remainingExperience > 0) {
        // Calculate the total accumulated experience the Pokemon
        // will have when it reaches the next level.
        totalExperienceForNextLevel = currentExperience + remainingExperience;
      }
    } catch (error) {
      // A Pokemon at Cobblemon's absolute maximum level may not have
      // a valid next-level XP requirement.
      //
      // Keep totalExperienceForNextLevel equal to currentExperience.
    }

    // Return a snapshot of the Pokemon's XP state.
    return {
      level: currentLevel,
      experience: currentExperience,
      totalForNextLevel: totalExperienceForNextLevel,
    };
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
