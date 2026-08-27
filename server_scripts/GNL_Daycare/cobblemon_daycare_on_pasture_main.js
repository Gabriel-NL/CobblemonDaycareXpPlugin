/* // =============================================================
// NOG - COBBLEMON DAYCARE
// MAIN RUNTIME
// =============================================================

(function () {
  // =============================================================
  // LIBRARY CHECK
  // =============================================================

  if (global.Nog == null || global.Nog.CobblemonDaycare == null) {
    console.error("[Cobblemon Daycare] Daycare library was not loaded.");

    return;
  }

  // =============================================================
  // LIBRARY REFERENCES
  // =============================================================

  const DaycareLib = global.Nog.CobblemonDaycare;
  const Helpers = global.Nog.Helpers;

  // =============================================================
  // IMPORTS
  // =============================================================

  const $PokemonEntity = Java.loadClass(
    "com.cobblemon.mod.common.entity.pokemon.PokemonEntity",
  );

  const $SidemodExperienceSource = Java.loadClass(
    "com.cobblemon.mod.common.api.pokemon.experience.SidemodExperienceSource",
  );

  const $Component = Java.loadClass("net.minecraft.network.chat.Component");

  // =============================================================
  // CONFIGURATION
  // =============================================================

  const LOG_TAG = "Cobblemon Daycare";

  const DEBUG = true;

  // 1200 ticks = 60 seconds
  const INTERVAL_TICKS = 100;

  // 5 XP every completed interval
  const XP_PER_INTERVAL = 60;

  const SCAN_EVERY_SECONDS = 10;
  const SCAN_EVERY_TICKS = Helpers.SecondsToTicks(SCAN_EVERY_SECONDS);

  // 3 empty scans = ~15 seconds before sleeping
  const EMPTY_SCANS_BEFORE_SLEEP = 3;

  const DAYCARE_XP_SOURCE = new $SidemodExperienceSource("nog_daycare");

  // TEMPORARY MOVEMENT TEST
  const MSG_INTERVAL_TICKS = Helpers.SecondsToTicks(1);
  const DISTANCE_REQUIRED_PER_REWARD = 10;
  const XP_AWARDED = 1;

  // =============================================================
  // RUNTIME STATE
  // =============================================================

  let notifiedEvolutionStages = new Set();

  let daycareSessions = new Map();

  let scanTickCounter = 0;

  let daycareAwake = true;

  let emptyScanStreak = 0;

  // Diagnostic information
  let xpAwardEventsSinceReload = 0;

  let xpAcceptedSinceReload = 0;

  let lastAwardPokemon = "";

  let lastAwardAmount = 0;

  let lastAwardTick = -1;

  let daycareStatusSamples = new Map();

  let runtimeTick = 0;

  //TEMP

  let movementMessageTickCounter = 0;

  let playerMovementSamples = new Map();

  // =============================================================
  // LOCAL LOGGING WRAPPERS
  // =============================================================

  if (global.Nog == null || global.Nog.CobblemonDaycare == null) {
    console.error("[Cobblemon Daycare] Daycare library was not loaded.");

    return;
  }

  if (global.Nog.Helpers == null) {
    console.error("[Cobblemon Daycare] Helpers library was not loaded.");

    return;
  }

  // =============================================================
  // WAKE / SLEEP
  // =============================================================

  function WakeDaycare(reason) {
    if (daycareAwake) {
      Helpers.Debug(DEBUG, LOG_TAG, "Daycare is already awake");
      return;
    }

    daycareAwake = true;

    scanTickCounter = SCAN_EVERY_TICKS;

    emptyScanStreak = 0;

    Helpers.Debug(DEBUG, LOG_TAG, "Waking daycare: " + reason);
  }

  function SleepDaycare() {
    daycareAwake = false;

    scanTickCounter = 0;

    emptyScanStreak = 0;

    Helpers.Debug(
      DEBUG,
      LOG_TAG,
      "No loaded daycare Pokemon remain. " + "Scanning is dormant.",
    );
  }

  // =============================================================
  // FIND LOADED DAYCARE POKEMON
  // =============================================================

  function GetLoadedDaycarePokemon(server) {
    let foundPokemon = [];

    let levelIterator = null;

    let currentLevel = null;

    let entityIterator = null;

    let currentEntity = null;

    let pokemon = null;

    levelIterator = server.getAllLevels().iterator();

    while (levelIterator.hasNext()) {
      currentLevel = levelIterator.next();

      entityIterator = currentLevel.getAllEntities().iterator();

      while (entityIterator.hasNext()) {
        currentEntity = entityIterator.next();

        if (!(currentEntity instanceof $PokemonEntity)) {
          continue;
        }

        pokemon = currentEntity.getPokemon();

        if (pokemon == null) {
          continue;
        }

        if (!DaycareLib.IsPokemonTethered(pokemon)) {
          continue;
        }

        foundPokemon.push({
          pokemon: pokemon,
          level: currentLevel,
        });
      }
    }

    return foundPokemon;
  }

  // =============================================================
  // LEVEL-UP NOTIFICATION
  // =============================================================

  function NotifyLevelUps(pokemon, oldLevel, newLevel) {
    let levelReached = oldLevel + 1;

    while (levelReached <= newLevel) {
      DaycareLib.NotifyOwner(
        pokemon,
        DaycareLib.GetPokemonName(pokemon) + " is level " + levelReached + "!",
      );

      levelReached++;
    }
  }

  // =============================================================
  // PROCESS ONE DAYCARE POKEMON
  // =============================================================

  function ProcessDaycarePokemon(pokemon, level) {
    let currentTick = runtimeTick;

    let session = DaycareLib.UpdateDaycareSession(
      pokemon,
      currentTick,
      daycareSessions,
    );

    if (session == null) {
      return;
    }

    let pokemonUuid = DaycareLib.GetSafePokemonUuid(pokemon);

    // First time this session is seen by the runtime.
    if (session.totalXpGained == null) {
      session.totalXpGained = 0;

      session.awayDisplayXp = 0;

      session.isLoaded = true;

      session.unloadedSinceRuntimeTick = null;

      session.pokemonName = DaycareLib.GetPokemonName(pokemon);
    }

    // Pokemon has just returned after being unloaded.
    if (!session.isLoaded) {
      session.isLoaded = true;

      session.unloadedSinceRuntimeTick = null;

      session.awayDisplayXp = 0;
    }

    session.lastSeenRuntimeTick = runtimeTick;

    session.pokemonName = DaycareLib.GetPokemonName(pokemon);

    // -------------------------------------------------------------
    // Evolution check
    //
    // This happens even before XP is awarded.
    //
    // Therefore, after reopening the world, a Pokemon that is
    // already ready to evolve can notify the player again.
    // -------------------------------------------------------------

    DaycareLib.CheckEvolutionNotification(pokemon, notifiedEvolutionStages);

    // -------------------------------------------------------------
    // TIME CALCULATION
    // -------------------------------------------------------------

    let lastTick = Number(session.lastTick);

    if (currentTick < lastTick) {
      session.lastTick = currentTick;

      Helpers.Debug(
        DEBUG,
        LOG_TAG,
        DaycareLib.GetPokemonName(pokemon) +
          ": game time moved backwards. " +
          "Session clock reset.",
      );

      return;
    }

    let elapsedTicks = currentTick - lastTick;

    let completedIntervals = Math.floor(elapsedTicks / INTERVAL_TICKS);

    if (completedIntervals <= 0) {
      return;
    }

    // -------------------------------------------------------------
    // XP CALCULATION
    // -------------------------------------------------------------

    let xpToGive = Math.floor(completedIntervals * XP_PER_INTERVAL);

    if (xpToGive <= 0) {
      return;
    }

    let intMax = 2147483647;

    let intervalsToConsume = completedIntervals;

    if (xpToGive > intMax) {
      intervalsToConsume = Math.floor(intMax / XP_PER_INTERVAL);

      xpToGive = Math.floor(intervalsToConsume * XP_PER_INTERVAL);
    }

    // Preserve incomplete interval time.
    //
    // Example:
    //
    // 127 elapsed ticks
    // 100 tick interval
    //
    // consume 100
    // preserve 27

    session.lastTick = lastTick + intervalsToConsume * INTERVAL_TICKS;

    // -------------------------------------------------------------
    // APPLY XP
    // -------------------------------------------------------------

    let oldLevel = Number(pokemon.getLevel());

    let oldExperience = Number(pokemon.getExperience());

    //pokemon.addExperience(DAYCARE_XP_SOURCE, xpToGive);

    let newLevel = Number(pokemon.getLevel());

    let newExperience = Number(pokemon.getExperience());

    // -------------------------------------------------------------
    // XP WAS NOT ACCEPTED
    // -------------------------------------------------------------

    if (oldExperience === newExperience && oldLevel === newLevel) {
      Helpers.Debug(
        DEBUG,
        LOG_TAG,
        DaycareLib.GetPokemonName(pokemon) + ": XP award produced no change.",
      );

      return;
    }

    // -------------------------------------------------------------
    // DIAGNOSTIC STATE
    // -------------------------------------------------------------

    let acceptedXp = Math.max(0, newExperience - oldExperience);

    session.totalXpGained += acceptedXp;

    xpAwardEventsSinceReload++;

    xpAcceptedSinceReload += acceptedXp;

    lastAwardPokemon = DaycareLib.GetPokemonName(pokemon);

    lastAwardAmount = acceptedXp;

    lastAwardTick = currentTick;

    Helpers.Debug(
      DEBUG,
      LOG_TAG,
      lastAwardPokemon + " received " + acceptedXp + " XP.",
    );

    // -------------------------------------------------------------
    // LEVEL-UP
    // -------------------------------------------------------------

    if (newLevel > oldLevel) {
      NotifyLevelUps(pokemon, oldLevel, newLevel);
    }

    // -------------------------------------------------------------
    // EVOLUTION AFTER XP
    // -------------------------------------------------------------

    DaycareLib.CheckEvolutionNotification(pokemon, notifiedEvolutionStages);
  }

  // =============================================================
  // MAIN DAYCARE SCAN
  // =============================================================

  function RunDaycareScan(server) {
    let loadedDaycarePokemon = GetLoadedDaycarePokemon(server);

    let seenPokemon = new Set();

    let activeDaycarePokemon = loadedDaycarePokemon.length;

    let index = 0;

    let entry = null;

    while (index < loadedDaycarePokemon.length) {
      entry = loadedDaycarePokemon[index];

      seenPokemon.add(DaycareLib.GetSafePokemonUuid(entry.pokemon));

      try {
        ProcessDaycarePokemon(entry.pokemon, entry.level);
      } catch (error) {
        Helpers.LogError(
          LOG_TAG,
          "processing Pokemon " + DaycareLib.GetSafePokemonUuid(entry.pokemon),
          error,
        );
      }

      index++;
    }

    // =============================================================
    // DETECT POKEMON THAT BECAME UNLOADED
    // =============================================================

    daycareSessions.forEach(function (session, pokemonUuid) {
      if (seenPokemon.has(pokemonUuid)) {
        return;
      }

      if (session.isLoaded) {
        session.isLoaded = false;

        session.unloadedSinceRuntimeTick = runtimeTick;

        session.awayDisplayXp = 0;

        Helpers.Debug(
          DEBUG,
          LOG_TAG,
          session.pokemonName + " is no longer loaded.",
        );
      }
    });

    // -------------------------------------------------------------
    // DORMANCY
    // -------------------------------------------------------------

    if (activeDaycarePokemon === 0) {
      emptyScanStreak++;

      Helpers.Debug(
        DEBUG,
        LOG_TAG,
        "Empty daycare scan " +
          emptyScanStreak +
          "/" +
          EMPTY_SCANS_BEFORE_SLEEP,
      );

      if (emptyScanStreak >= EMPTY_SCANS_BEFORE_SLEEP) {
        SleepDaycare();
      }
    } else {
      emptyScanStreak = 0;
    }
  }

  // =============================================================
  // TEMPORARY MOVEMENT TEST
  // =============================================================

  function GetPlayerMovementKey(player) {
    return String(player.uuid);
  }

  function SamplePlayerMovement(player) {
    let playerKey = GetPlayerMovementKey(player);

    let currentX = Number(player.getX());
    let currentZ = Number(player.getZ());

    let sample = playerMovementSamples.get(playerKey);

    // The first sample only establishes the starting position.
    if (sample == null) {
      playerMovementSamples.set(playerKey, {
        lastX: currentX,
        lastZ: currentZ,
        totalMeters: 0,
      });

      return;
    }

    let deltaX = currentX - sample.lastX;
    let deltaZ = currentZ - sample.lastZ;

    let metersWalked = Math.sqrt(deltaX * deltaX + deltaZ * deltaZ);

    sample.totalMeters += metersWalked;
    sample.lastX = currentX;
    sample.lastZ = currentZ;

    let xpGained =
      Math.floor(sample.totalMeters / DISTANCE_REQUIRED_PER_REWARD) *
      XP_AWARDED;

    SendMessage(
      player,
      "Meters walked: " +
        sample.totalMeters.toFixed(2) +
        ", XP gained: " +
        xpGained +
        ", meters to XP rate: " +
        DISTANCE_REQUIRED_PER_REWARD +
        ":" +
        XP_AWARDED,
    );
  }

  function RunMovementMessageTick(server) {
    movementMessageTickCounter++;

    if (movementMessageTickCounter < MSG_INTERVAL_TICKS) {
      return;
    }

    movementMessageTickCounter = 0;

    let players = server.getPlayerList().getPlayers().iterator();

    while (players.hasNext()) {
      try {
        SamplePlayerMovement(players.next());
      } catch (error) {
        Helpers.LogError(
          LOG_TAG,
          "temporary player movement measurement",
          error,
        );
      }
    }
  }

  // =============================================================
  // SERVER TICK
  // =============================================================

  function RunDaycareTick(event) {
    RunMovementMessageTick(event.server);
    if (daycareSessions.size > 0) {
      runtimeTick++;

      UpdateAwayDisplayXp();
    }

    if (!daycareAwake) {
      return;
    }

    scanTickCounter++;

    if (scanTickCounter < SCAN_EVERY_TICKS) {
      return;
    }

    scanTickCounter = 0;

    try {
      RunDaycareScan(event.server);
    } catch (error) {
      Helpers.LogError(LOG_TAG, "main daycare scan", error);
    }
  }

  // =============================================================
  // TETHERED POKEMON SPAWNED
  // =============================================================

  function HandleDaycarePokemonSpawn(event) {
    if (daycareAwake) {
      return;
    }

    try {
      let entity = event.entity;

      if (!(entity instanceof $PokemonEntity)) {
        return;
      }

      let pokemon = entity.getPokemon();

      if (pokemon == null) {
        return;
      }

      if (!DaycareLib.IsPokemonTethered(pokemon)) {
        return;
      }

      WakeDaycare("a tethered Pokemon loaded");
    } catch (error) {
      Helpers.LogError(LOG_TAG, "checking spawned Pokemon", error);
    }
  }

  // =============================================================
  // PLAYER MESSAGE
  // =============================================================

  function SendMessage(player, message) {
    player.sendSystemMessage($Component.literal(message));
  }

  // =============================================================
  // /daycarexp
  // =============================================================

  function RunDaycareXpCommand(event) {
    try {
      let player = event.player;

      if (player == null) {
        return;
      }

      let loadedDaycarePokemon = GetLoadedDaycarePokemon(event.server);

      SendMessage(player, "=== Cobblemon Daycare XP Status ===");

      SendMessage(
        player,
        "State: " +
          (daycareAwake ? "AWAKE" : "DORMANT") +
          " | Loaded daycare Pokemon: " +
          loadedDaycarePokemon.length,
      );

      let xpPerHour = XP_PER_INTERVAL * (20 / INTERVAL_TICKS) * 3600;

      SendMessage(
        player,
        "Rate: " +
          XP_PER_INTERVAL +
          " XP every " +
          INTERVAL_TICKS / 20 +
          "s (" +
          xpPerHour +
          " XP/hour)",
      );

      SendMessage(
        player,
        "Successful awards since reload: " +
          xpAwardEventsSinceReload +
          " | Accepted XP: " +
          xpAcceptedSinceReload,
      );

      if (lastAwardTick >= 0) {
        SendMessage(
          player,
          "Last award: " +
            lastAwardPokemon +
            " received " +
            lastAwardAmount +
            " XP at tick " +
            lastAwardTick,
        );
      } else {
        SendMessage(player, "Last award: none since reload.");
      }

      if (loadedDaycarePokemon.length === 0) {
        SendMessage(player, "No loaded tethered Pokemon were found.");

        return;
      }

      let index = 0;

      let entry = null;

      let pokemon = null;

      let level = null;

      let pokemonUuid = "";

      let pokemonLevel = 0;

      let pokemonExperience = 0;

      let currentTick = 0;

      let pendingIntervals = 0;

      let pendingXp = 0;

      let session = null;

      let tetheringId = null;

      let previousSample = null;

      let xpDelta = 0;

      let levelDelta = 0;

      let deltaText = "";

      while (index < loadedDaycarePokemon.length) {
        entry = loadedDaycarePokemon[index];

        pokemon = entry.pokemon;

        level = entry.level;

        pokemonUuid = DaycareLib.GetSafePokemonUuid(pokemon);

        pokemonLevel = Number(pokemon.getLevel());

        pokemonExperience = Number(pokemon.getExperience());

        currentTick = runtimeTick;
        pendingIntervals = 0;

        pendingXp = 0;

        session = daycareSessions.get(pokemonUuid);

        tetheringId = DaycareLib.GetPokemonTetheringId(pokemon);

        if (session != null && session.tetheringId === tetheringId) {
          let elapsedTicks = currentTick - Number(session.lastTick);

          if (elapsedTicks < 0) {
            elapsedTicks = 0;
          }

          pendingIntervals = Math.floor(elapsedTicks / INTERVAL_TICKS);

          pendingXp = Math.floor(pendingIntervals * XP_PER_INTERVAL);
        }

        previousSample = daycareStatusSamples.get(pokemonUuid);

        deltaText = "baseline recorded";

        if (previousSample != null) {
          xpDelta = pokemonExperience - previousSample.experience;

          levelDelta = pokemonLevel - previousSample.level;

          if (xpDelta > 0) {
            deltaText = "WORKING: +" + xpDelta + " XP since last check";
          } else if (levelDelta > 0) {
            deltaText =
              "WORKING: +" + levelDelta + " level(s) since last check";
          } else {
            deltaText = "no XP change since last check";
          }
        }

        daycareStatusSamples.set(pokemonUuid, {
          experience: pokemonExperience,

          level: pokemonLevel,

          sampledAtTick: currentTick,
        });

        SendMessage(
          player,
          "- " +
            DaycareLib.GetPokemonName(pokemon) +
            " | Lv " +
            pokemonLevel +
            " | total XP " +
            pokemonExperience +
            " | " +
            deltaText,
        );
        let displaySession = daycareSessions.get(pokemonUuid);

        if (displaySession != null) {
          SendMessage(
            player,
            "  Session XP gained: " +
              displaySession.totalXpGained +
              " | Away XP: " +
              displaySession.awayDisplayXp,
          );
        }
        SendMessage(
          player,
          "  Pending: " +
            pendingXp +
            " XP (" +
            pendingIntervals +
            " complete interval(s))",
        );

        index++;
      }

      SendMessage(
        player,
        "Run /daycarexp again after at least " +
          INTERVAL_TICKS / 20 +
          " seconds to compare XP.",
      );
    } catch (error) {
      Helpers.LogError(LOG_TAG, "/daycarexp command", error);
    }
  }

  function UpdateAwayDisplayXp() {
    daycareSessions.forEach(function (session) {
      if (session.isLoaded) {
        return;
      }

      if (session.unloadedSinceRuntimeTick == null) {
        return;
      }

      let unloadedTicks = runtimeTick - session.unloadedSinceRuntimeTick;

      if (unloadedTicks < 0) {
        unloadedTicks = 0;
      }

      let awayIntervals = Math.floor(unloadedTicks / INTERVAL_TICKS);

      session.awayDisplayXp = awayIntervals * XP_PER_INTERVAL;
    });
  }

  // =============================================================
  // SERVER EVENTS
  // =============================================================

  ServerEvents.tick((event) => RunDaycareTick(event));

  // =============================================================
  // BLOCK EVENTS
  // =============================================================

  BlockEvents.placed("cobblemon:pasture", (event) =>
    WakeDaycare("a Pasture was placed"),
  );

  BlockEvents.rightClicked("cobblemon:pasture", (event) =>
    WakeDaycare("a Pasture was interacted with"),
  );

  // =============================================================
  // ENTITY EVENTS
  // =============================================================

  EntityEvents.spawned((event) => HandleDaycarePokemonSpawn(event));

  // =============================================================
  // COMMANDS
  // =============================================================

  ServerEvents.basicCommand("daycarexp", (event) => RunDaycareXpCommand(event));

  // =============================================================
  // LOAD
  // =============================================================

  console.info(
    "[Nog.CobblemonDaycare] Runtime loaded: " +
      XP_PER_INTERVAL +
      " XP every " +
      INTERVAL_TICKS / 20 +
      " seconds.",
  );
})();
 */
