// Core Pasture daycare behavior. This file does not register events or commands.
global.Nog = global.Nog || {};
global.Nog.CobblemonDaycare = global.Nog.CobblemonDaycare || {};

(function (Daycare) {
  function PlayerKey(player) {
    return String(player.uuid);
  }

  function PokemonIdSignature(ids) {
    let values = [];
    for (let index = 0; index < ids.length; index++) values.push(String(ids[index]));
    return values.join("|");
  }

  function RefreshPasturedPokemonIds(player, state) {
    let ids = [];
    let seen = new Set();
    let stores = global.Nog.Cobblemon.GetPlayerPcStores(player);
    for (let storeIndex = 0; storeIndex < stores.length; storeIndex++) {
      let iterator = stores[storeIndex].iterator();
      while (iterator.hasNext()) {
        let pokemon = iterator.next();
        let uuidKey = String(pokemon.getUuid());
        if (global.Nog.Cobblemon.IsTethered(pokemon) && !seen.has(uuidKey)) {
          seen.add(uuidKey);
          ids.push(pokemon.getUuid());
        }
      }
    }
    state.pasturedPokemonIdsByPlayer.set(PlayerKey(player), ids);
    return ids;
  }

  function DeactivateTracker(player, state, notification) {
    let playerKey = PlayerKey(player);
    if (!state.trackedPokemonByPlayer.has(playerKey)) return false;
    state.trackedPokemonByPlayer.delete(playerKey);
    if (notification != null) global.Nog.Helpers.Tell(player, notification);
    return true;
  }

  function UnsubscribePlayer(playerKey, state) {
    let subscriptions = state.pcChangeSubscriptions.get(playerKey);
    if (subscriptions == null) return;
    for (let index = 0; index < subscriptions.length; index++) {
      subscriptions[index].unsubscribe();
    }
    state.pcChangeSubscriptions.delete(playerKey);
  }

  function SubscribePlayer(player, state) {
    let playerKey = PlayerKey(player);
    UnsubscribePlayer(playerKey, state);
    RefreshPasturedPokemonIds(player, state);
    let stores = global.Nog.Cobblemon.GetPlayerPcStores(player);
    let subscriptions = [];
    for (let index = 0; index < stores.length; index++) {
      subscriptions.push(stores[index].getPcChangeObservable().subscribe(function () {
        state.sleepingPlayers.delete(playerKey);
        let refreshedIds = RefreshPasturedPokemonIds(player, state);
        let tracker = state.trackedPokemonByPlayer.get(playerKey);
        if (tracker != null && PokemonIdSignature(refreshedIds) !== tracker.listSignature) {
          DeactivateTracker(
            player,
            state,
            "Pastured Pokemon list changed. Deactivating tracker.",
          );
        }
      }));
    }
    state.pcChangeSubscriptions.set(playerKey, subscriptions);
  }

  function GetStats(player, state) {
    let ids = state.pasturedPokemonIdsByPlayer.get(PlayerKey(player)) || [];
    let cap = global.Nog.Cobblemon.GetPlayerLevelCap(player);
    let stats = {
      eligiblePokemonCount: 0,
      totalPokemonCount: 0,
      cappedPokemonCount: 0,
      currentLevelCap: cap,
      eligiblePokemonIds: [],
      cappedPokemonIds: [],
    };
    let seen = new Set();
    for (let index = 0; index < ids.length; index++) {
      let uuidKey = String(ids[index]);
      if (seen.has(uuidKey)) continue;
      seen.add(uuidKey);
      let pokemon = global.Nog.Cobblemon.FindPokemonInPlayerPcStores(player, ids[index]);
      if (!global.Nog.Cobblemon.IsTethered(pokemon)) continue;
      stats.totalPokemonCount++;
      if (Number(pokemon.getLevel()) >= cap || !pokemon.canLevelUpFurther()) {
        stats.cappedPokemonCount++;
        stats.cappedPokemonIds.push(ids[index]);
      } else {
        stats.eligiblePokemonCount++;
        stats.eligiblePokemonIds.push(ids[index]);
      }
    }
    return stats;
  }

  function GeneratePendingXp(state, playerKey, distance, blocksPerMilestone, xpPerMilestone) {
    let availableDistance = Number(state.distanceRemaindersByPlayer.get(playerKey) || 0) + distance;
    let milestones = Math.floor(availableDistance / blocksPerMilestone);
    state.distanceRemaindersByPlayer.set(
      playerKey,
      availableDistance - milestones * blocksPerMilestone,
    );
    let generatedXp = milestones * xpPerMilestone;
    state.pendingXpByPlayer.set(
      playerKey,
      Number(state.pendingXpByPlayer.get(playerKey) || 0) + generatedXp,
    );
    return generatedXp;
  }

  function PlanDistribution(ids, totalXp) {
    let count = ids.length;
    let xpPerPokemon = count > 0 ? Math.floor(totalXp / count) : 0;
    return {
      xpPerPokemon: xpPerPokemon,
      preservedXp: totalXp - xpPerPokemon * count,
    };
  }

  function RemoveLocalId(state, playerKey, pokemonUuid) {
    let ids = state.pasturedPokemonIdsByPlayer.get(playerKey) || [];
    state.pasturedPokemonIdsByPlayer.set(playerKey, ids.filter(function (id) {
      return String(id) !== String(pokemonUuid);
    }));
  }

  function TryGiveXp(player, pokemonUuid, requestedXp, xpSource, notificationsEnabled) {
    let pokemon = global.Nog.Cobblemon.FindPokemonInPlayerPcStores(player, pokemonUuid);
    if (!global.Nog.Cobblemon.IsTethered(pokemon)) {
      return { acceptedXp: 0, capped: false, blocked: true };
    }
    let safeRequest = Math.floor(Number(requestedXp));
    if (!isFinite(safeRequest) || safeRequest <= 0) {
      return { acceptedXp: 0, capped: false, blocked: true };
    }
    let cap = global.Nog.Cobblemon.GetPlayerLevelCap(player);
    if (Number(pokemon.getLevel()) >= cap) {
      return { acceptedXp: 0, capped: true, blocked: false };
    }
    let cappedRequest = Math.min(safeRequest, Number(pokemon.getExperienceToLevel(cap)));
    if (cappedRequest <= 0) return { acceptedXp: 0, capped: true, blocked: false };

    let oldExperience = Number(pokemon.getExperience());
    let oldLevel = Number(pokemon.getLevel());
    pokemon.addExperience(xpSource, cappedRequest);
    let newExperience = Number(pokemon.getExperience());
    let newLevel = Number(pokemon.getLevel());
    let acceptedXp = Math.max(0, newExperience - oldExperience);
    let reachedCap = newLevel >= global.Nog.Cobblemon.GetPlayerLevelCap(player);

    if (notificationsEnabled && newLevel > oldLevel) {
      for (let level = oldLevel + 1; level <= newLevel; level++) {
        global.Nog.Helpers.Tell(
          player,
          global.Nog.Cobblemon.GetPokemonName(pokemon) + " reached level " + level + ".",
        );
      }
    }
    if (notificationsEnabled && reachedCap) {
      global.Nog.Helpers.Tell(
        player,
        global.Nog.Cobblemon.GetPokemonName(pokemon) +
          " reached your current level cap (" + newLevel + ").",
      );
    }
    return {
      acceptedXp: acceptedXp,
      capped: reachedCap,
      blocked: acceptedXp <= 0 && !reachedCap,
    };
  }

  function ApplyPendingXp(player, state, xpSource, notificationsEnabled) {
    let playerKey = PlayerKey(player);
    let stats = GetStats(player, state);
    let eligibleIds = stats.eligiblePokemonIds.slice();
    for (let index = 0; index < stats.cappedPokemonIds.length; index++) {
      RemoveLocalId(state, playerKey, stats.cappedPokemonIds[index]);
    }
    if (eligibleIds.length === 0) {
      state.sleepingPlayers.add(playerKey);
      return 0;
    }
    eligibleIds.sort(function (a, b) { return String(a).localeCompare(String(b)); });
    let totalAccepted = 0;
    while (eligibleIds.length > 0) {
      let cachedXp = Number(state.pendingXpByPlayer.get(playerKey) || 0);
      let equalShare = Math.floor(cachedXp / eligibleIds.length);
      if (equalShare <= 0) break;
      let survivors = [];
      for (let index = 0; index < eligibleIds.length; index++) {
        let pokemonUuid = eligibleIds[index];
        let result = TryGiveXp(player, pokemonUuid, equalShare, xpSource, notificationsEnabled);
        if (result.acceptedXp > 0) {
          state.pendingXpByPlayer.set(
            playerKey,
            Math.max(0, Number(state.pendingXpByPlayer.get(playerKey) || 0) - result.acceptedXp),
          );
          totalAccepted += result.acceptedXp;
        }
        if (result.capped) RemoveLocalId(state, playerKey, pokemonUuid);
        else if (!result.blocked && result.acceptedXp === equalShare) survivors.push(pokemonUuid);
      }
      eligibleIds = survivors;
    }
    if (eligibleIds.length === 0) state.sleepingPlayers.add(playerKey);
    return totalAccepted;
  }

  function GetXpProgress(pokemon) {
    let level = Number(pokemon.getLevel());
    let experience = Number(pokemon.getExperience());
    let totalForNextLevel = experience;
    try { totalForNextLevel += Number(pokemon.getExperienceToLevel(level + 1)); }
    catch (_) {}
    return { experience: experience, totalForNextLevel: totalForNextLevel, level: level };
  }

  function FormatXpProgress(progress) {
    return progress.experience + "/" + progress.totalForNextLevel + " XP Lv " + progress.level;
  }

  function CheckTrackerAgainstLocalList(player, state) {
    let tracker = state.trackedPokemonByPlayer.get(PlayerKey(player));
    if (tracker == null) return;
    let ids = state.pasturedPokemonIdsByPlayer.get(PlayerKey(player)) || [];
    if (PokemonIdSignature(ids) !== tracker.listSignature) {
      DeactivateTracker(player, state, "Pastured Pokemon list changed. Deactivating tracker.");
    }
  }

  function HandlePlayerInterval(player, server, runtime) {
    let state = runtime.state;
    let playerKey = PlayerKey(player);
    let currentPosition = { x: Number(player.getX()), z: Number(player.getZ()) };
    state.currentPositions.set(playerKey, currentPosition);
    let lastPosition = state.lastPositions.get(playerKey);
    let distance = 0;
    if (lastPosition != null) {
      let deltaX = currentPosition.x - lastPosition.x;
      let deltaZ = currentPosition.z - lastPosition.z;
      distance = Math.sqrt(deltaX * deltaX + deltaZ * deltaZ);
    }
    state.lastPositions.set(playerKey, currentPosition);
    if (state.sleepingPlayers.has(playerKey)) return;

    let stats = GetStats(player, state);
    let generatedXp = 0;
    if (stats.eligiblePokemonCount > 0) {
      generatedXp = GeneratePendingXp(
        state,
        playerKey,
        distance,
        runtime.getVariable(server, "blocks_per_milestone"),
        runtime.getVariable(server, "xp_per_milestone"),
      );
    }

    let tracker = state.trackedPokemonByPlayer.get(playerKey);
    let trackedExperienceBefore = null;
    if (tracker != null) {
      let tracked = global.Nog.Cobblemon.FindPokemonInPlayerPcStores(player, tracker.pokemonUuid);
      if (tracked != null) trackedExperienceBefore = Number(tracked.getExperience());
    }
    let appliedXp = ApplyPendingXp(
      player,
      state,
      runtime.xpSource,
      runtime.getVariable(server, "levelUpNotification"),
    );
    CheckTrackerAgainstLocalList(player, state);

    tracker = state.trackedPokemonByPlayer.get(playerKey);
    if (tracker != null && trackedExperienceBefore != null) {
      let tracked = global.Nog.Cobblemon.FindPokemonInPlayerPcStores(player, tracker.pokemonUuid);
      if (tracked != null && Number(tracked.getExperience()) > trackedExperienceBefore) {
        global.Nog.Helpers.Tell(player, global.Nog.Cobblemon.GetPokemonName(tracked) + " XP tracker:");
        global.Nog.Helpers.Tell(player, "Before: " + FormatXpProgress(tracker.startingProgress));
        global.Nog.Helpers.Tell(player, "Current: " + FormatXpProgress(GetXpProgress(tracked)));
      }
    }

    stats = GetStats(player, state);
    let pendingXp = Number(state.pendingXpByPlayer.get(playerKey) || 0);
    let plan = PlanDistribution(stats.eligiblePokemonIds, pendingXp);
    if (runtime.getDebugger(server, "walk")) {
      global.Nog.Helpers.Tell(
        player,
        "Distance since last position: " + distance.toFixed(1).replace(".", ",") +
          " | XP generated: " + generatedXp + " | XP applied: " + appliedXp +
          " | Hypothetical XP: " + pendingXp + " | XP per Pokemon: " + plan.xpPerPokemon +
          " | XP preserved for next batch: " + plan.preservedXp +
          " | Total pastured Pokemon: " + stats.totalPokemonCount +
          " | Current player cap: " + stats.currentLevelCap +
          " | Level-capped ignored: " + stats.cappedPokemonCount,
      );
    }
  }

  function CleanupPlayer(player, state) {
    let playerKey = PlayerKey(player);
    DeactivateTracker(player, state, null);
    UnsubscribePlayer(playerKey, state);
    state.lastPositions.delete(playerKey);
    state.currentPositions.delete(playerKey);
    state.distanceRemaindersByPlayer.delete(playerKey);
    state.pendingXpByPlayer.delete(playerKey);
    state.pasturedPokemonIdsByPlayer.delete(playerKey);
    state.sleepingPlayers.delete(playerKey);
  }

  function CleanupAll(state) {
    state.pcChangeSubscriptions.forEach(function (subscriptions) {
      for (let index = 0; index < subscriptions.length; index++) subscriptions[index].unsubscribe();
    });
    state.pcChangeSubscriptions.clear();
    state.lastPositions.clear();
    state.currentPositions.clear();
    state.distanceRemaindersByPlayer.clear();
    state.pendingXpByPlayer.clear();
    state.pasturedPokemonIdsByPlayer.clear();
    state.sleepingPlayers.clear();
    state.trackedPokemonByPlayer.clear();
  }

  Daycare.PlayerKey = PlayerKey;
  Daycare.PokemonIdSignature = PokemonIdSignature;
  Daycare.DeactivateTracker = DeactivateTracker;
  Daycare.GetXpProgress = GetXpProgress;
  Daycare.FormatXpProgress = FormatXpProgress;
  Daycare.SubscribePlayer = SubscribePlayer;
  Daycare.HandlePlayerInterval = HandlePlayerInterval;
  Daycare.CleanupPlayer = CleanupPlayer;
  Daycare.CleanupAll = CleanupAll;
})(global.Nog.CobblemonDaycare);
