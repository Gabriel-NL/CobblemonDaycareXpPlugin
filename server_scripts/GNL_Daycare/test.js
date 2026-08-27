// Load Minecraft's text-component class so the command can create a chat message.
const $Component = Java.loadClass("net.minecraft.network.chat.Component");

// Load Brigadier's boolean argument type for true/false command input.
const $BoolArgumentType = Java.loadClass(
  "com.mojang.brigadier.arguments.BoolArgumentType",
);

// Load Brigadier's integer argument type for persistent numeric variables.
const $TestIntegerArgumentType = Java.loadClass(
  "com.mojang.brigadier.arguments.IntegerArgumentType",
);

// Load Cobblemon's main API entry point so UUIDs can be resolved through PC storage.
const $TestCobblemonApi = Java.loadClass("com.cobblemon.mod.common.Cobblemon");

// Load Radical Cobblemon Trainers' dynamic per-player level-cap helper.
const $TestRctLevelUtils = Java.loadClass(
  "com.gitlab.srcmc.rctmod.api.utils.LevelUtils",
);

// Load the silent sidemod XP source type for the future XP application step.
const $SidemodExperienceSource = Java.loadClass(
  "com.cobblemon.mod.common.api.pokemon.experience.SidemodExperienceSource",
);

// Create the future daycare XP source without applying any XP yet.
const TEST_DAYCARE_XP_SOURCE = new $SidemodExperienceSource("nog_daycare_test");

// Define every persistent daycare variable, its type, default, and minimum.
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

// Create a persistent-data key for one daycare variable.
function GetDaycareVariablePersistentKey(variableName) {
  return "nogDaycareVariable_" + variableName;
}

// Read one validated persistent daycare variable.
function GetDaycareVariable(server, variableName) {
  let definition = DAYCARE_VARIABLES[variableName];

  if (definition == null) {
    return null;
  }

  let savedData = server.persistentData;
  let persistentKey = GetDaycareVariablePersistentKey(variableName);

  // Migrate a value saved under this variable's previous name.
  if (
    !savedData.contains(persistentKey) &&
    definition.legacyName != null
  ) {
    let legacyKey = GetDaycareVariablePersistentKey(definition.legacyName);

    if (savedData.contains(legacyKey)) {
      savedData.putInt(persistentKey, savedData.getInt(legacyKey));
    }
  }

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

  if (!isFinite(value) || value < definition.minimum) {
    value = definition.defaultValue;
    savedData.putInt(persistentKey, value);
  }

  return Math.floor(value);
}

// Validate and persist one daycare variable.
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

// Store how many server ticks have passed since the previous position sample.
let positionSampleTickCounter = 0;

// Store the previous sampled position for each online player.
let lastPositions = new Map();

// Store the newest sampled position for each online player.
let currentPositions = new Map();

// Store each player's incomplete distance toward their next XP milestone.
let distanceRemaindersByPlayer = new Map();

// Store each player's temporary integer XP while actual rewards remain paused.
let hypotheticalXpByPlayer = new Map();

// Store each player's latest hypothetical per-Pokemon XP distribution plan.
let hypotheticalXpDistributionByPlayer = new Map();

// Track players whose distribution is asleep because no Pokemon can receive XP.
let sleepingDistributionPlayers = new Set();

// Store pastured Pokemon UUIDs, grouped by their owner's UUID.
let pasturedPokemonIdsByPlayer = new Map();

// Store one PC-change subscription for each online player.
let pcChangeSubscriptions = new Map();

// Get every PC store associated with one player.
function GetPlayerPcStores(player) {
  // Ask Cobblemon for all PC stores belonging to this player's UUID.
  let stores = $TestCobblemonApi.INSTANCE
    .getStorage()
    .getPCs(player.uuid, player.registryAccess())
    .iterator();

  // Create a normal JavaScript array for repeated use.
  let playerPcStores = [];

  // Copy only the PC store references into the local array.
  while (stores.hasNext()) {
    playerPcStores.push(stores.next());
  }

  // Return the existing stores without recreating their Pokemon.
  return playerPcStores;
}

// Resolve one Pokemon UUID by checking all PC stores associated with a player.
function FindPokemonInPlayerPcStores(player, pokemonUuid) {
  // Get all PC stores currently associated with this player.
  let playerPcStores = GetPlayerPcStores(player);

  // Check each PC store until the UUID is found.
  for (let index = 0; index < playerPcStores.length; index++) {
    // Resolve the UUID inside the current PC store.
    let pokemon = playerPcStores[index].get(pokemonUuid);

    // Return the existing Pokemon object as soon as it is found.
    if (pokemon != null) {
      return pokemon;
    }
  }

  // Report that no associated PC contains this UUID.
  return null;
}

// Rebuild one player's local UUID list from only that player's PC storage.
function RefreshPasturedPokemonIdsForPlayer(player) {
  // Use this player's UUID string as their individual list key.
  let playerKey = String(player.uuid);

  // Create a replacement list so removed tether IDs disappear locally.
  let playerPokemonIds = [];

  // Get every PC store associated with this player.
  let playerPcStores = GetPlayerPcStores(player);

  // Visit each of this player's PC stores.
  for (let storeIndex = 0; storeIndex < playerPcStores.length; storeIndex++) {
    // Get an iterator containing every Pokemon in the current PC store.
    let storedPokemon = playerPcStores[storeIndex].iterator();

    // Visit every Pokemon in this PC store.
    while (storedPokemon.hasNext()) {
      // Get the next current Pokemon object from PC storage.
      let pokemon = storedPokemon.next();

      // Ignore Pokemon that are not currently tethered to a Pasture.
      if (pokemon.getTetheringId() == null) {
        continue;
      }

      // Store only the stable Pokemon UUID in the local list.
      playerPokemonIds.push(pokemon.getUuid());
    }
  }

  // Replace only this player's local list; this never modifies their PC.
  pasturedPokemonIdsByPlayer.set(playerKey, playerPokemonIds);
}

// Stop listening for changes to one player's PC.
function UnsubscribeFromPlayerPc(playerKey) {
  // Get the existing subscription for this player.
  let subscription = pcChangeSubscriptions.get(playerKey);

  // Stop when this player has no active subscription.
  if (subscription == null) {
    return;
  }

  // Detach every callback registered for this player's PC stores.
  for (let index = 0; index < subscription.length; index++) {
    subscription[index].unsubscribe();
  }

  // Remove the inactive subscription from the local map.
  pcChangeSubscriptions.delete(playerKey);
}

// Initialize one player's list and listen for future PC changes.
function SubscribeToPlayerPc(player) {
  // Use this player's UUID string as the subscription key.
  let playerKey = String(player.uuid);

  // Prevent duplicate callbacks for the same player.
  UnsubscribeFromPlayerPc(playerKey);

  // Build this player's initial local list once.
  RefreshPasturedPokemonIdsForPlayer(player);

  // Get every PC store associated with this player.
  let playerPcStores = GetPlayerPcStores(player);

  // Store all subscriptions belonging to this player.
  let subscriptions = [];

  // Subscribe separately to each associated PC store.
  for (let index = 0; index < playerPcStores.length; index++) {
    // Get the current PC store's change observable.
    let observable = playerPcStores[index].getPcChangeObservable();

    // Refresh only this player's list when this specific PC changes.
    let subscription = observable.subscribe(function () {
      // Wake this player's distribution when their PC reports any change.
      sleepingDistributionPlayers.delete(playerKey);

      RefreshPasturedPokemonIdsForPlayer(player);
    });

    // Retain this subscription for logout and shutdown cleanup.
    subscriptions.push(subscription);
  }

  // Retain all of this player's subscriptions under their UUID.
  pcChangeSubscriptions.set(playerKey, subscriptions);
}

// Convert one player's newly measured distance into pending milestone XP.
function GeneratePendingXpFromDistance(server, playerKey, measuredDistance) {
  // Read the player's incomplete distance from previous position samples.
  let previousRemainder = Number(
    distanceRemaindersByPlayer.get(playerKey) || 0,
  );

  // Add the newly measured distance to the existing remainder.
  let availableDistance = previousRemainder + measuredDistance;

  // Read the current persistent distance required by one milestone.
  let blocksPerMilestone = GetDaycareVariable(
    server,
    "blocks_per_milestone",
  );

  // Calculate how many complete milestones fit into the available distance.
  let completedMilestones = Math.floor(
    availableDistance / blocksPerMilestone,
  );

  // Preserve only the distance that did not complete a milestone.
  let newRemainder =
    availableDistance - completedMilestones * blocksPerMilestone;

  // Save the incomplete distance for the player's next position sample.
  distanceRemaindersByPlayer.set(playerKey, newRemainder);

  // Calculate the XP produced by the newly completed milestones.
  let generatedXp =
    completedMilestones * GetDaycareVariable(server, "xp_per_milestone");

  // Read hypothetical integer XP already calculated for this player.
  let previousHypotheticalXp = Number(
    hypotheticalXpByPlayer.get(playerKey) || 0,
  );

  // Add only the newly generated integer XP to the temporary total.
  hypotheticalXpByPlayer.set(
    playerKey,
    previousHypotheticalXp + generatedXp,
  );

  // Return the amount generated by only this position sample.
  return generatedXp;
}

// Collect one player's Pokemon and Pasture statistics for XP previewing.
function GetPasturedPokemonStatsForPlayer(player, playerKey) {
  // Read this player's current local UUID list.
  let pasturedPokemonIds = pasturedPokemonIdsByPlayer.get(playerKey);

  // Return zero when no local list exists yet.
  if (pasturedPokemonIds == null) {
    return {
      eligiblePokemonCount: 0,
      totalPokemonCount: 0,
      cappedPokemonCount: 0,
      currentLevelCap: Number($TestRctLevelUtils.levelCap(player)),
      eligiblePokemonIds: [],
      cappedPokemonIds: [],
    };
  }

  // Use a set so the same Pokemon UUID cannot be checked twice.
  let uniquePokemonIds = new Set();

  // Start the eligible Pokemon count at zero.
  let eligiblePokemonCount = 0;

  // Store UUIDs belonging only to Pokemon below the player's current cap.
  let eligiblePokemonIds = [];

  // Start the total unique pastured Pokemon count at zero.
  let totalPokemonCount = 0;

  // Start the ignored level-capped Pokemon count at zero.
  let cappedPokemonCount = 0;

  // Store UUIDs that are already at the player's current level cap.
  let cappedPokemonIds = [];

  // Read Radical Cobblemon Trainers' current progression cap for this player.
  let currentLevelCap = Number($TestRctLevelUtils.levelCap(player));

  // Check every cached UUID in this player's local list.
  for (let index = 0; index < pasturedPokemonIds.length; index++) {
    // Get the next stable Pokemon UUID.
    let pokemonUuid = pasturedPokemonIds[index];

    // Convert the UUID to text for duplicate detection.
    let pokemonKey = String(pokemonUuid);

    // Ignore a UUID that was already checked.
    if (uniquePokemonIds.has(pokemonKey)) {
      continue;
    }

    // Remember that this UUID has now been checked.
    uniquePokemonIds.add(pokemonKey);

    // Resolve the current Pokemon object through this player's PC stores.
    let pokemon = FindPokemonInPlayerPcStores(player, pokemonUuid);

    // Ignore a UUID that can no longer be resolved.
    if (pokemon == null) {
      continue;
    }

    // Read the Pokemon's current Pasture tethering identifier.
    let tetheringId = pokemon.getTetheringId();

    // Ignore a Pokemon that is no longer assigned to a Pasture.
    if (tetheringId == null) {
      continue;
    }

    // Include this valid tethered Pokemon in the total Pasture count.
    totalPokemonCount++;

    // Ignore a Pokemon at the player's current cap or Cobblemon's absolute cap.
    if (
      Number(pokemon.getLevel()) >= currentLevelCap ||
      !pokemon.canLevelUpFurther()
    ) {
      // Record that this pastured Pokemon was excluded for being level capped.
      cappedPokemonCount++;

      // Retain the UUID so distribution can remove it from the local index.
      cappedPokemonIds.push(pokemonUuid);

      continue;
    }

    // Include this Pokemon in the hypothetical XP division.
    eligiblePokemonCount++;

    // Retain its UUID for the per-Pokemon distribution plan.
    eligiblePokemonIds.push(pokemonUuid);
  }

  // Return all values needed by the hypothetical XP preview.
  return {
    eligiblePokemonCount: eligiblePokemonCount,
    totalPokemonCount: totalPokemonCount,
    cappedPokemonCount: cappedPokemonCount,
    currentLevelCap: currentLevelCap,
    eligiblePokemonIds: eligiblePokemonIds,
    cappedPokemonIds: cappedPokemonIds,
  };
}

// Divide hypothetical XP among all eligible pastured Pokemon using integers.
function PlanHypotheticalXpDistribution(playerKey, pokemonIds, totalXp) {
  // Copy the UUID list so sorting does not mutate the statistics result.
  let sortedPokemonIds = pokemonIds.slice();

  // Use UUID text to keep remainder distribution deterministic.
  sortedPokemonIds.sort(function (firstUuid, secondUuid) {
    return String(firstUuid).localeCompare(String(secondUuid));
  });

  // Create the new per-Pokemon distribution plan.
  let allocations = [];

  // Save an empty plan when no Pokemon can currently receive XP.
  if (sortedPokemonIds.length === 0) {
    let emptyPlan = {
      allocations: allocations,
      xpPerPokemon: 0,
      distributableXp: 0,
      preservedXp: totalXp,
    };

    hypotheticalXpDistributionByPlayer.set(playerKey, emptyPlan);

    return emptyPlan;
  }

  // Calculate the equal integer amount every eligible Pokemon receives.
  let baseXp = Math.floor(totalXp / sortedPokemonIds.length);

  // Calculate the complete equal batch that could be distributed.
  let distributableXp = baseXp * sortedPokemonIds.length;

  // Preserve all XP that cannot provide the same integer amount to everyone.
  let preservedXp = totalXp - distributableXp;

  // Create allocations only after there is at least one XP for every Pokemon.
  if (baseXp > 0) {
    // Create one equal planned allocation for every eligible Pokemon.
    for (let index = 0; index < sortedPokemonIds.length; index++) {
      // Store the UUID and the same integer share for every Pokemon.
      allocations.push({
        pokemonUuid: sortedPokemonIds[index],
        plannedXp: baseXp,
      });
    }
  }

  // Group the allocations with the distributable and preserved amounts.
  let plan = {
    allocations: allocations,
    xpPerPokemon: baseXp,
    distributableXp: distributableXp,
    preservedXp: preservedXp,
  };

  // Save the completed plan without applying or consuming any XP.
  hypotheticalXpDistributionByPlayer.set(playerKey, plan);

  // Return the plan for preview information.
  return plan;
}

// Consume only an equal XP batch after every planned award is confirmed.
function ConsumeConfirmedHypotheticalXp(playerKey, distributionPlan) {
  // Refuse to consume XP when no complete equal allocation exists.
  if (
    distributionPlan == null ||
    distributionPlan.allocations.length === 0 ||
    distributionPlan.distributableXp <= 0
  ) {
    return false;
  }

  // Read the player's current hypothetical XP balance.
  let currentXp = Number(hypotheticalXpByPlayer.get(playerKey) || 0);

  // Refuse to consume more XP than the player currently has cached.
  if (currentXp < distributionPlan.distributableXp) {
    return false;
  }

  // Preserve only the XP that was not part of the confirmed equal batch.
  hypotheticalXpByPlayer.set(
    playerKey,
    currentXp - distributionPlan.distributableXp,
  );

  // Report that the confirmed batch was consumed successfully.
  return true;
}

// Run the enclosed function once for every server tick.
ServerEvents.tick(function (event) {
  // Add the current tick to the counter.
  positionSampleTickCounter++;

  // Convert the persistent check interval from seconds to server ticks.
  let checkIntervalTicks =
    GetDaycareVariable(event.server, "check_interval_seconds") * 20;

  // Stop this tick handler until the configured interval is reached.
  if (positionSampleTickCounter < checkIntervalTicks) {
    // Exit without sending a message yet.
    return;
  }

  // Reset the counter so the next check uses the current persistent interval.
  positionSampleTickCounter = 0;

  // Stop position tracking and messages while the walking debugger is inactive.
  if (!GetSavedDebuggerValue(event.server, "walk")) {
    // Remove old samples so re-enabling starts from a fresh position.
    lastPositions.clear();

    // Remove the newest samples for the same reason.
    currentPositions.clear();

    // Exit without displaying any walking message.
    return;
  }

  // Get an iterator containing every player currently online.
  let players = event.server.getPlayerList().getPlayers().iterator();

  // Sample and display the distance separately for every online player.
  while (players.hasNext()) {
    // Get the next online player.
    let player = players.next();

    // Use the player's UUID string as the key in both position maps.
    let playerKey = String(player.uuid);

    // Store the player's current horizontal coordinates.
    let currentPosition = {
      x: Number(player.getX()),
      z: Number(player.getZ()),
    };

    // Save the newest position in the current-position map.
    currentPositions.set(playerKey, currentPosition);

    // Read the position recorded during the previous sample.
    let lastPosition = lastPositions.get(playerKey);

    // Start with zero distance when no previous sample exists.
    let distance = 0;

    // Calculate horizontal Euclidean distance after the first sample.
    if (lastPosition != null) {
      // Calculate the change on the X axis.
      let deltaX = currentPosition.x - lastPosition.x;

      // Calculate the change on the Z axis.
      let deltaZ = currentPosition.z - lastPosition.z;

      // Calculate the straight-line horizontal distance between both samples.
      distance = Math.sqrt(deltaX * deltaX + deltaZ * deltaZ);
    }

    // While asleep, update the baseline without generating or distributing XP.
    if (sleepingDistributionPlayers.has(playerKey)) {
      lastPositions.set(playerKey, currentPosition);

      continue;
    }

    // Start with no generated XP when the player has no pastured Pokemon IDs.
    let generatedXp = 0;

    // Collect this player's current Pasture and Pokemon preview statistics.
    let pasturedPokemonStats = GetPasturedPokemonStatsForPlayer(
      player,
      playerKey,
    );

    // Read the number of non-level-capped Pokemon eligible for hypothetical XP.
    let pasturedPokemonCount = pasturedPokemonStats.eligiblePokemonCount;

    // Generate pending milestone XP only when at least one Pasture UUID is known.
    if (pasturedPokemonCount > 0) {
      generatedXp = GeneratePendingXpFromDistance(
        event.server,
        playerKey,
        distance,
      );
    }

    // Apply complete equal batches and iteratively redistribute cap leftovers.
    let appliedXp = ApplyHypotheticalXpDistribution(player, playerKey);

    // Refresh statistics after capped recipients were removed locally.
    pasturedPokemonStats = GetPasturedPokemonStatsForPlayer(player, playerKey);

    // Refresh the eligible count after real XP application.
    pasturedPokemonCount = pasturedPokemonStats.eligiblePokemonCount;

    // Read the player's complete temporary hypothetical-XP value.
    let hypotheticalXp = Number(hypotheticalXpByPlayer.get(playerKey) || 0);

    // Build an integer distribution using only Pokemon below the player cap.
    let hypotheticalDistribution = PlanHypotheticalXpDistribution(
      playerKey,
      pasturedPokemonStats.eligiblePokemonIds,
      hypotheticalXp,
    );

    // Read the equal integer share from the completed distribution plan.
    let xpPerPokemon = hypotheticalDistribution.xpPerPokemon;

    // Format the distance with one decimal place and a decimal comma.
    let formattedDistance = distance.toFixed(1).replace(".", ",");

    // Display only this player's distance since their previous sample.
    player.sendSystemMessage(
      $Component.literal(
        "Distance since last position: " +
          formattedDistance +
          " | XP generated: " +
          generatedXp +
          " | XP applied: " +
          appliedXp +
          " | Hypothetical XP: " +
          hypotheticalXp +
          " | XP per Pokemon: " +
          xpPerPokemon +
          " | XP preserved for next batch: " +
          hypotheticalDistribution.preservedXp +
          " | Total pastured Pokemon: " +
          pasturedPokemonStats.totalPokemonCount +
          " | Current player cap: " +
          pasturedPokemonStats.currentLevelCap +
          " | Level-capped ignored: " +
          pasturedPokemonStats.cappedPokemonCount,
      ),
    );

    // Move the current position into the last-position map for the next sample.
    lastPositions.set(playerKey, currentPosition);
  }
});

// Build the initial Pasture reference lists when the server finishes loading.
ServerEvents.loaded(function (event) {
  // Get every player already online when the server-loaded event runs.
  let players = event.server.getPlayerList().getPlayers().iterator();

  // Initialize and subscribe each currently online player separately.
  while (players.hasNext()) {
    SubscribeToPlayerPc(players.next());
  }
});

// Initialize the temporary UUID lists when a player joins the running server.
PlayerEvents.loggedIn(function (event) {
  // Initialize this player's list and subscribe only to this player's PC.
  SubscribeToPlayerPc(event.player);
});

// Remove the PC listener when a player leaves the server.
PlayerEvents.loggedOut(function (event) {
  // Stop listening to the departing player's PC changes.
  let playerKey = String(event.player.uuid);

  // Stop listening to the departing player's PC changes.
  UnsubscribeFromPlayerPc(playerKey);

  // Discard this session's previous position for the departing player.
  lastPositions.delete(playerKey);

  // Discard this session's current position for the departing player.
  currentPositions.delete(playerKey);

  // Discard this session's incomplete distance for the departing player.
  distanceRemaindersByPlayer.delete(playerKey);

  // Discard this temporary hypothetical XP because persistence is not added yet.
  hypotheticalXpByPlayer.delete(playerKey);

  // Discard this player's temporary hypothetical distribution plan.
  hypotheticalXpDistributionByPlayer.delete(playerKey);

  // Remove the departing player from the sleeping-distribution set.
  sleepingDistributionPlayers.delete(playerKey);
});

// Explicitly discard all temporary references when the server stops.
ServerEvents.unloaded(function () {
  // Unsubscribe every remaining PC listener before discarding local state.
  pcChangeSubscriptions.forEach(function (subscriptions) {
    for (let index = 0; index < subscriptions.length; index++) {
      subscriptions[index].unsubscribe();
    }
  });

  // Clear all retained subscription references.
  pcChangeSubscriptions.clear();

  // Clear the per-player Pasture lists.
  pasturedPokemonIdsByPlayer.clear();

  // Clear all temporary fractional-distance values.
  distanceRemaindersByPlayer.clear();

  // Clear all temporary hypothetical-XP values.
  hypotheticalXpByPlayer.clear();

  // Clear all temporary per-Pokemon distribution plans.
  hypotheticalXpDistributionByPlayer.clear();

  // Clear all sleeping-distribution flags.
  sleepingDistributionPlayers.clear();
});

/*
Separator, do not edit this




*/

// Define every available debugger and its default boolean value.
const DEBUGGERS = {
  // Control walking-related debug output.
  walk: false,
  // Control level-gained debug output.
  level_gained: false,
};

// Create the persistent-data key belonging to a debugger name.
function GetDebuggerPersistentKey(debuggerName) {
  // Prefix the dictionary key to avoid collisions with unrelated saved data.
  return "nogDaycareDebugger_" + debuggerName;
}

// Read a saved debugger value, creating a false default when it is missing.
function GetSavedDebuggerValue(server, debuggerName) {
  // Read the server's persistent data container.
  let savedData = server.persistentData;

  // Create the full persistent-data key for this dictionary entry.
  let persistentKey = GetDebuggerPersistentKey(debuggerName);

  // Create the value the first time this debugger is accessed.
  if (!savedData.contains(persistentKey)) {
    // Save the default value declared in the debugger dictionary.
    savedData.putBoolean(persistentKey, DEBUGGERS[debuggerName]);
  }

  // Read the stored boolean value.
  let enabled = savedData.getBoolean(persistentKey);

  // Keep the in-memory dictionary synchronized with persistent data.
  DEBUGGERS[debuggerName] = enabled;

  // Return the synchronized dictionary value.
  return DEBUGGERS[debuggerName];
}

// Save a debugger value in the server's persistent data.
function SetSavedDebuggerValue(server, debuggerName, enabled) {
  // Create the full persistent-data key for this dictionary entry.
  let persistentKey = GetDebuggerPersistentKey(debuggerName);

  // Save only a true or false value.
  server.persistentData.putBoolean(persistentKey, Boolean(enabled));

  // Update the in-memory dictionary immediately as well.
  DEBUGGERS[debuggerName] = Boolean(enabled);
}

// Convert a boolean into a readable status word.
function GetDebuggerStatusText(enabled) {
  // Display active for true and inactive for false.
  return enabled ? "active (true)" : "inactive (false)";
}

// Run the behavior belonging to /daycarexp test.
function RunDaycareTestCommand(context) {
  // Get the player who executed the command.
  let player = context.source.player;

  // Stop if the command was executed somewhere without a player.
  if (player == null) {
    return 0;
  }

  // Send the message only to the player who executed the command.
  player.sendSystemMessage($Component.literal("Hi! This is my script!"));

  // Tell Minecraft that the command completed successfully.
  return 1;
}

// Get a readable name from an existing Pokemon reference.
function GetPasturedPokemonName(pokemon) {
  // Try to use the Pokemon's normal display name first.
  try {
    return pokemon.getDisplayName(false).getString();
  } catch (error) {
    // Fall back to the species identifier if the display name is unavailable.
    return String(pokemon.getSpecies().getResourceIdentifier());
  }
}

// Remove one UUID only from this script's local Pasture index.
function RemovePasturedPokemonIdLocally(playerKey, pokemonUuid) {
  // Read the player's current local UUID list.
  let pokemonIds = pasturedPokemonIdsByPlayer.get(playerKey);

  // Stop when the player has no local list.
  if (pokemonIds == null) {
    return;
  }

  // Keep every UUID except the capped Pokemon being removed locally.
  let remainingIds = pokemonIds.filter(function (existingUuid) {
    return String(existingUuid) !== String(pokemonUuid);
  });

  // Replace only the local index; this never removes a Pokemon from Cobblemon.
  pasturedPokemonIdsByPlayer.set(playerKey, remainingIds);
}

// Resolve a pastured Pokemon UUID and apply a cap-safe integer XP request.
function TryGiveXpToPasturedPokemon(player, pokemonUuid, xpAmount) {
  // Resolve a fresh Pokemon object across all PC stores associated with the player.
  let pokemon = FindPokemonInPlayerPcStores(player, pokemonUuid);

  // Stop if this UUID is no longer present in the player's PC storage.
  if (pokemon == null) {
    return { acceptedXp: 0, capped: false, blocked: true };
  }

  // Stop if the resolved Pokemon is no longer assigned to a Pasture.
  if (pokemon.getTetheringId() == null) {
    return { acceptedXp: 0, capped: false, blocked: true };
  }

  // Convert the requested amount to a safe integer for the future API call.
  let safeXpAmount = Math.floor(Number(xpAmount));

  // Stop if the requested amount is invalid or cannot add XP.
  if (!isFinite(safeXpAmount) || safeXpAmount <= 0) {
    return { acceptedXp: 0, capped: false, blocked: true };
  }

  // Read Radical Cobblemon Trainers' current cap at the moment of application.
  let currentLevelCap = Number($TestRctLevelUtils.levelCap(player));

  // Stop immediately when this Pokemon is already at the player's current cap.
  if (Number(pokemon.getLevel()) >= currentLevelCap) {
    return { acceptedXp: 0, capped: true, blocked: false };
  }

  // Calculate the most XP this Pokemon can accept before reaching that cap.
  let xpUntilPlayerCap = Number(pokemon.getExperienceToLevel(currentLevelCap));

  // Clamp the request so daycare XP cannot cross the player's relative cap.
  let cappedRequest = Math.min(safeXpAmount, xpUntilPlayerCap);

  // Treat a non-positive cap allowance as already capped.
  if (cappedRequest <= 0) {
    return { acceptedXp: 0, capped: true, blocked: false };
  }

  // Measure total experience before applying the capped request.
  let oldExperience = Number(pokemon.getExperience());

  // Measure the level before applying XP for optional notifications.
  let oldLevel = Number(pokemon.getLevel());

  // Apply real daycare XP through Cobblemon's sidemod experience source.
  pokemon.addExperience(TEST_DAYCARE_XP_SOURCE, cappedRequest);

  // Measure total experience after Cobblemon processes the request.
  let newExperience = Number(pokemon.getExperience());

  // Measure the level after Cobblemon processes the request.
  let newLevel = Number(pokemon.getLevel());

  // Count only XP that Cobblemon demonstrably accepted.
  let acceptedXp = Math.max(0, newExperience - oldExperience);

  // Re-read the dynamic cap and level after application.
  let reachedPlayerCap =
    newLevel >= Number($TestRctLevelUtils.levelCap(player));

  // Read the persistent notification preference at application time.
  let notificationsEnabled = GetDaycareVariable(
    player.server,
    "levelUpNotification",
  );

  // Notify only when enabled and this XP application gained at least one level.
  if (notificationsEnabled && newLevel > oldLevel) {
    // Send one message for every individual level gained.
    for (let reachedLevel = oldLevel + 1; reachedLevel <= newLevel; reachedLevel++) {
      player.sendSystemMessage(
        $Component.literal(
          GetPasturedPokemonName(pokemon) +
            " reached level " +
            reachedLevel +
            ".",
        ),
      );
    }
  }

  // Notify only when enabled and the Pokemon reached the player's current cap.
  if (notificationsEnabled && reachedPlayerCap) {
    player.sendSystemMessage(
      $Component.literal(
        GetPasturedPokemonName(pokemon) +
          " reached your current level cap (" +
          newLevel +
          ").",
      ),
    );
  }

  // Report the confirmed result to the iterative distributor.
  return {
    acceptedXp: acceptedXp,
    capped: reachedPlayerCap,
    blocked: acceptedXp <= 0 && !reachedPlayerCap,
  };
}

// Apply cached XP repeatedly until no complete equal batch remains.
function ApplyHypotheticalXpDistribution(player, playerKey) {
  // Collect a fresh eligible list using the player's current relative cap.
  let stats = GetPasturedPokemonStatsForPlayer(player, playerKey);

  // Copy eligible UUIDs so local removals cannot disturb this pass.
  let eligiblePokemonIds = stats.eligiblePokemonIds.slice();

  // Remove already-capped Pokemon from only this script's local address list.
  for (let index = 0; index < stats.cappedPokemonIds.length; index++) {
    RemovePasturedPokemonIdLocally(playerKey, stats.cappedPokemonIds[index]);
  }

  // Sleep when no currently indexed Pokemon can receive XP.
  if (eligiblePokemonIds.length === 0) {
    sleepingDistributionPlayers.add(playerKey);

    return 0;
  }

  // Sort UUIDs so application order remains deterministic.
  eligiblePokemonIds.sort(function (firstUuid, secondUuid) {
    return String(firstUuid).localeCompare(String(secondUuid));
  });

  // Track the total amount actually accepted during this distribution run.
  let totalAcceptedXp = 0;

  // Continue while enough cached XP exists to offer everyone an equal integer.
  while (eligiblePokemonIds.length > 0) {
    // Read the balance again because confirmed awards decrement it immediately.
    let cachedXp = Number(hypotheticalXpByPlayer.get(playerKey) || 0);

    // Calculate the equal integer request for the current eligible group.
    let xpPerPokemon = Math.floor(cachedXp / eligiblePokemonIds.length);

    // Preserve the remainder and stop when a complete one-XP batch is impossible.
    if (xpPerPokemon <= 0) {
      break;
    }

    // Build the eligible group for another redistribution pass.
    let nextEligiblePokemonIds = [];

    // Apply the same integer request to every currently eligible Pokemon.
    for (let index = 0; index < eligiblePokemonIds.length; index++) {
      // Get the next stable UUID in deterministic order.
      let pokemonUuid = eligiblePokemonIds[index];

      // Apply a cap-safe request and measure what Cobblemon accepted.
      let result = TryGiveXpToPasturedPokemon(
        player,
        pokemonUuid,
        xpPerPokemon,
      );

      // Consume only XP confirmed by the before-and-after measurement.
      if (result.acceptedXp > 0) {
        let currentCachedXp = Number(
          hypotheticalXpByPlayer.get(playerKey) || 0,
        );

        hypotheticalXpByPlayer.set(
          playerKey,
          Math.max(0, currentCachedXp - result.acceptedXp),
        );

        totalAcceptedXp += result.acceptedXp;
      }

      // Remove capped Pokemon only from the local recipient-address list.
      if (result.capped) {
        RemovePasturedPokemonIdLocally(playerKey, pokemonUuid);

        continue;
      }

      // Keep only Pokemon that accepted the full equal request.
      if (!result.blocked && result.acceptedXp === xpPerPokemon) {
        nextEligiblePokemonIds.push(pokemonUuid);
      }
    }

    // Continue with survivors so XP refused at caps can be redistributed.
    eligiblePokemonIds = nextEligiblePokemonIds;
  }

  // Sleep if every recipient was capped, missing, or blocked during application.
  if (eligiblePokemonIds.length === 0) {
    sleepingDistributionPlayers.add(playerKey);
  }

  // Return the total confirmed XP removed from the player's cached balance.
  return totalAcceptedXp;
}

// Display the executing player's currently loaded Pasture Pokemon.
function RunMyPasturedCobblemonsCommand(context) {
  // Get the player who executed the command.
  let player = context.source.player;

  // Stop if the command was executed somewhere without a player.
  if (player == null) {
    return 0;
  }

  // Use the executing player's UUID to select only their individual list.
  let playerKey = String(player.uuid);

  // Get this player's current list of stable Pokemon UUIDs.
  let pasturedPokemonIds = pasturedPokemonIdsByPlayer.get(playerKey);

  // Explain when no loaded pastured Pokemon belong to this player.
  if (pasturedPokemonIds == null || pasturedPokemonIds.length === 0) {
    player.sendSystemMessage(
      $Component.literal("You have no loaded Pokemon currently on a Pasture."),
    );

    // Tell Minecraft that the command completed successfully.
    return 1;
  }

  // Display every Pokemon UUID belonging to the executing player.
  for (let index = 0; index < pasturedPokemonIds.length; index++) {
    // Get the next stable Pokemon UUID from the player's list.
    let pokemonUuid = pasturedPokemonIds[index];

    // Resolve the current Pokemon object across the player's associated PC stores.
    let pokemon = FindPokemonInPlayerPcStores(player, pokemonUuid);

    // Ignore a UUID that is no longer present in the player's PC storage.
    if (pokemon == null) {
      continue;
    }

    // Ignore a Pokemon that is no longer assigned to any Pasture.
    if (pokemon.getTetheringId() == null) {
      continue;
    }

    // Read the Pokemon's current name.
    let pokemonName = GetPasturedPokemonName(pokemon);

    // Read the Pokemon's current level.
    let pokemonLevel = Number(pokemon.getLevel());

    // Display the requested name-and-level format.
    player.sendSystemMessage(
      $Component.literal("[" + pokemonName + "] Lv [" + pokemonLevel + "]"),
    );
  }

  // Tell Minecraft that the command completed successfully.
  return 1;
}

// Display the current state of every daycare debugger.
function RunDebuggersStatusCommand(context) {
  // Get the player who executed the command.
  let player = context.source.player;

  // Stop if the command was executed somewhere without a player.
  if (player == null) {
    return 0;
  }

  // Get every debugger name declared in the dictionary.
  let debuggerNames = Object.keys(DEBUGGERS);

  // Visit every debugger so its current value can be displayed.
  for (let index = 0; index < debuggerNames.length; index++) {
    // Read the current debugger name.
    let debuggerName = debuggerNames[index];

    // Read this debugger's persistent boolean value.
    let enabled = GetSavedDebuggerValue(player.server, debuggerName);

    // Display this debugger's name and current value.
    player.sendSystemMessage(
      $Component.literal(debuggerName + ": " + GetDebuggerStatusText(enabled)),
    );
  }

  // Tell Minecraft that the command completed successfully.
  return 1;
}

// Create the execution function for one named debugger setter.
function CreateSetDebuggerRunFunction(debuggerName) {
  // Return a function that remembers the debugger name supplied above.
  return function (context) {
    // Get the player who executed the command.
    let player = context.source.player;

    // Stop if the command was executed somewhere without a player.
    if (player == null) {
      return 0;
    }

    // Read the true or false value supplied after the debugger name.
    let enabled = $BoolArgumentType.getBool(context, "enabled");

    // Save the selected debugger's new value in persistent server data.
    SetSavedDebuggerValue(player.server, debuggerName, enabled);

    // Confirm the selected debugger's new value to the player.
    player.sendSystemMessage(
      $Component.literal(
        debuggerName + " is now " + GetDebuggerStatusText(enabled) + ".",
      ),
    );

    // Tell Minecraft that the command completed successfully.
    return 1;
  };
}

// Display one persistent daycare variable to the executing player.
function SendDaycareVariableValue(player, variableName) {
  // Read the latest persisted and validated value.
  let value = GetDaycareVariable(player.server, variableName);

  // Display the variable name and its current value.
  player.sendSystemMessage(
    $Component.literal(variableName + ": " + String(value)),
  );
}

// Display every persistent daycare variable.
function RunAllDaycareVariablesCommand(context) {
  // Get the player who executed the command.
  let player = context.source.player;

  // Stop if the command was executed somewhere without a player.
  if (player == null) {
    return 0;
  }

  // Get every variable name declared in the shared definition table.
  let variableNames = Object.keys(DAYCARE_VARIABLES);

  // Display every current persistent value.
  for (let index = 0; index < variableNames.length; index++) {
    SendDaycareVariableValue(player, variableNames[index]);
  }

  // Tell Minecraft that the command completed successfully.
  return 1;
}

// Create a command callback that displays only one selected variable.
function CreateShowDaycareVariableRunFunction(variableName) {
  return function (context) {
    let player = context.source.player;

    if (player == null) {
      return 0;
    }

    SendDaycareVariableValue(player, variableName);

    return 1;
  };
}

// Create a command callback that validates and saves one selected variable.
function CreateSetDaycareVariableRunFunction(variableName) {
  return function (context) {
    let player = context.source.player;

    if (player == null) {
      return 0;
    }

    let definition = DAYCARE_VARIABLES[variableName];
    let newValue = null;

    if (definition.type === "boolean") {
      newValue = $BoolArgumentType.getBool(context, "value");
    } else {
      newValue = $TestIntegerArgumentType.getInteger(context, "value");
    }

    if (!SetDaycareVariable(player.server, variableName, newValue)) {
      player.sendSystemMessage(
        $Component.literal("Invalid value for " + variableName + "."),
      );

      return 0;
    }

    SendDaycareVariableValue(player, variableName);

    return 1;
  };
}

// Create and return a reusable literal subcommand definition.
function CreateSubcommand(Commands, subcommandName, runFunction) {
  // Build the named command node and connect it to its behavior function.
  return Commands.literal(subcommandName).executes(runFunction);
}

// Access Minecraft's command builder from the command-registry event.
ServerEvents.commandRegistry(function (event) {
  // Store the command builder in a short local variable.
  let Commands = event.commands;

  // Build the generic set branch below debuggers_status.
  let setDebuggerCommand = Commands.literal("set");

  // Get every debugger name declared in the dictionary.
  let debuggerNames = Object.keys(DEBUGGERS);

  // Create one literal command branch for every dictionary entry.
  for (let index = 0; index < debuggerNames.length; index++) {
    // Read the debugger name that will appear in command autocomplete.
    let debuggerName = debuggerNames[index];

    // Attach: set <debugger name> <true or false>.
    setDebuggerCommand.then(
      Commands.literal(debuggerName).then(
        // Require a true or false value named enabled.
        Commands.argument("enabled", $BoolArgumentType.bool()).executes(
          CreateSetDebuggerRunFunction(debuggerName),
        ),
      ),
    );
  }

  // Build the status command and attach the generated setter branches.
  let debuggersStatusCommand = Commands.literal("debuggers_status")
    // Display all debugger values when no additional argument is supplied.
    .executes(RunDebuggersStatusCommand)
    // Attach the generic set command below debuggers_status.
    .then(setDebuggerCommand);

  // Build /daycarexp variables and display all values when used alone.
  let variablesCommand = Commands.literal("variables").executes(
    RunAllDaycareVariablesCommand,
  );

  // Get all variable names so literal branches also provide autocomplete.
  let variableNames = Object.keys(DAYCARE_VARIABLES);

  // Add show and set branches for every declared variable.
  for (let index = 0; index < variableNames.length; index++) {
    // Read the variable represented by this literal command branch.
    let variableName = variableNames[index];

    // Read its validation metadata.
    let definition = DAYCARE_VARIABLES[variableName];

    // Create /daycarexp variables <variable>.
    let variableCommand = Commands.literal(variableName).executes(
      CreateShowDaycareVariableRunFunction(variableName),
    );

    // Create the correctly typed value argument for this variable.
    let valueArgument = null;

    if (definition.type === "boolean") {
      valueArgument = Commands.argument("value", $BoolArgumentType.bool());
    } else {
      valueArgument = Commands.argument(
        "value",
        $TestIntegerArgumentType.integer(definition.minimum),
      );
    }

    // Attach: variables <variable> set <validated value>.
    variableCommand.then(
      Commands.literal("set").then(
        valueArgument.executes(
          CreateSetDaycareVariableRunFunction(variableName),
        ),
      ),
    );

    // Attach this variable branch to /daycarexp variables.
    variablesCommand.then(variableCommand);
  }

  // Register /daycarexp and attach both available subcommands.
  event.register(
    Commands.literal("daycarexp")
      // Attach /daycarexp test through the generic factory.
      .then(CreateSubcommand(Commands, "test", RunDaycareTestCommand))
      // Attach /daycarexp mypasturedcobblemons through the generic factory.
      .then(
        CreateSubcommand(
          Commands,
          "mypasturedcobblemons",
          RunMyPasturedCobblemonsCommand,
        ),
      )
      // Attach the debugger status and setter command tree.
      .then(debuggersStatusCommand)
      // Attach the persistent variable display and setter command tree.
      .then(variablesCommand),
  );
});

