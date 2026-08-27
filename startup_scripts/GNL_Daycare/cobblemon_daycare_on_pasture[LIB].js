// Core session logic for the Pasture daycare. This file never registers events.
global.Nog = global.Nog || {};
global.Nog.CobblemonDaycare = global.Nog.CobblemonDaycare || {};

(function (Daycare) {
  function PlayerKey(player) {
    return String(player.uuid);
  }

  function RefreshPasturedPokemonIds(player, state) {
    let ids = [];
    let seen = new Set();
    let stores = global.Nog.Cobblemon.GetPlayerPcStores(player);
    for (let storeIndex = 0; storeIndex < stores.length; storeIndex++) {
      let pokemonIterator = stores[storeIndex].iterator();
      while (pokemonIterator.hasNext()) {
        let pokemon = pokemonIterator.next();
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
        RefreshPasturedPokemonIds(player, state);
      }));
    }
    state.pcChangeSubscriptions.set(playerKey, subscriptions);
  }

  function GetStats(player, state) {
    let playerKey = PlayerKey(player);
    let ids = state.pasturedPokemonIdsByPlayer.get(playerKey) || [];
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
      distributableXp: xpPerPokemon * count,
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
        player.tell(global.Nog.Cobblemon.GetPokemonName(pokemon) + " reached level " + level + ".");
      }
    }
    if (notificationsEnabled && reachedCap) {
      player.tell(global.Nog.Cobblemon.GetPokemonName(pokemon) +
        " reached your current level cap (" + newLevel + ").");
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

  function CleanupPlayer(playerKey, state) {
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
  }

  Daycare.PlayerKey = PlayerKey;
  Daycare.RefreshPasturedPokemonIds = RefreshPasturedPokemonIds;
  Daycare.SubscribePlayer = SubscribePlayer;
  Daycare.GetStats = GetStats;
  Daycare.GeneratePendingXp = GeneratePendingXp;
  Daycare.PlanDistribution = PlanDistribution;
  Daycare.ApplyPendingXp = ApplyPendingXp;
  Daycare.CleanupPlayer = CleanupPlayer;
  Daycare.CleanupAll = CleanupAll;
})(global.Nog.CobblemonDaycare);
