// Reusable Cobblemon storage and Pokemon helpers.
global.Nog = global.Nog || {};
global.Nog.Cobblemon = global.Nog.Cobblemon || {};

(function (CobblemonHelpers) {
  const $CobblemonApi = Java.loadClass("com.cobblemon.mod.common.Cobblemon");
  const $RctLevelUtils = Java.loadClass("com.gitlab.srcmc.rctmod.api.utils.LevelUtils");

  function GetPlayerPcStores(player) {
    let iterator = $CobblemonApi.INSTANCE.getStorage()
      .getPCs(player.uuid, player.registryAccess()).iterator();
    let stores = [];
    while (iterator.hasNext()) stores.push(iterator.next());
    return stores;
  }

  function FindPokemonInPlayerPcStores(player, pokemonUuid) {
    let stores = GetPlayerPcStores(player);
    for (let index = 0; index < stores.length; index++) {
      let pokemon = stores[index].get(pokemonUuid);
      if (pokemon != null) return pokemon;
    }
    return null;
  }

  function GetPokemonName(pokemon) {
    try {
      return pokemon.getDisplayName(false).getString();
    } catch (_) {
      try { return String(pokemon.getSpecies().getResourceIdentifier()); }
      catch (_) { return "Pokemon"; }
    }
  }

  CobblemonHelpers.GetPlayerPcStores = GetPlayerPcStores;
  CobblemonHelpers.FindPokemonInPlayerPcStores = FindPokemonInPlayerPcStores;
  CobblemonHelpers.GetPokemonName = GetPokemonName;
  CobblemonHelpers.GetPlayerLevelCap = function (player) {
    return Number($RctLevelUtils.levelCap(player));
  };
  CobblemonHelpers.IsTethered = function (pokemon) {
    return pokemon != null && pokemon.getTetheringId() != null;
  };
})(global.Nog.Cobblemon);
