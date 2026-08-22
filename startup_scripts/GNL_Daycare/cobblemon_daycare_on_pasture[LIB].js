// =============================================================
// NOG - COBBLEMON DAYCARE LIBRARY
// =============================================================
// Hello, world! (Codex edit test)

// Create root namespace if it does not exist.
global.Nog = global.Nog || {};

// Create Cobblemon Daycare namespace if it does not exist.
global.Nog.CobblemonDaycare = global.Nog.CobblemonDaycare || {};

// =============================================================
// IMPORTS
// =============================================================

const $Component = Java.loadClass("net.minecraft.network.chat.Component");
const $LevelUpEvolution = Java.loadClass(
  "com.cobblemon.mod.common.pokemon.evolution.variants.LevelUpEvolution",
);

// =============================================================
// CONTEXT SPECIFIC FUNCTIONS
// =============================================================

function GetPokemonName(pokemon) {
  try {
    return pokemon.getDisplayName(false).getString();
  } catch (error) {
    try {
      return String(pokemon.getSpecies().getResourceIdentifier());
    } catch (_) {
      return "Pokemon";
    }
  }
}

function GetSafePokemonUuid(pokemon) {
  try {
    return String(pokemon.getUuid());
  } catch (_) {
    return "<unknown UUID>";
  }
}

function NotifyOwner(pokemon, message) {
  let owner = pokemon.getOwnerPlayer();

  if (owner == null) {
    return false;
  }

  owner.sendSystemMessage($Component.literal(message));

  return true;
}

function IsPokemonReadyToEvolve(pokemon) {
  let evolutions = pokemon.getEvolutions().iterator();

  while (evolutions.hasNext()) {
    let evolution = evolutions.next();

    if (!(evolution instanceof $LevelUpEvolution)) {
      continue;
    }

    try {
      if (evolution.test(pokemon)) {
        return true;
      }
    } catch (_) {}
  }

  return false;
}

function CheckEvolutionNotification(pokemon, notifiedEvolutionStages) {
  if (!IsPokemonReadyToEvolve(pokemon)) {
    return false;
  }

  let pokemonUuid = GetSafePokemonUuid(pokemon);

  let currentSpecies = String(pokemon.getSpecies().getResourceIdentifier());

  let notificationKey = pokemonUuid + "|" + currentSpecies;

  if (notifiedEvolutionStages.has(notificationKey)) {
    return false;
  }

  let delivered = NotifyOwner(
    pokemon,
    GetPokemonName(pokemon) + " is ready to evolve!",
  );

  if (!delivered) {
    return false;
  }

  notifiedEvolutionStages.add(notificationKey);

  return true;
}

/*
Sample usage:
DaycareLib.CheckEvolutionNotification(
    pokemon,
    notifiedEvolutionStages
)
*/

function GetPokemonTetheringId(pokemon) {
  let tetheringId = pokemon.getTetheringId();

  if (tetheringId == null) {
    return null;
  }

  return String(tetheringId);
}

function IsPokemonTethered(pokemon) {
  return GetPokemonTetheringId(pokemon) != null;
}

function UpdateDaycareSession(pokemon, currentTick, daycareSessions) {
  let pokemonUuid = GetSafePokemonUuid(pokemon);

  let tetheringId = GetPokemonTetheringId(pokemon);

  if (tetheringId == null) {
    return null;
  }

  let existingSession = daycareSessions.get(pokemonUuid);

  if (existingSession == null || existingSession.tetheringId !== tetheringId) {
    let newSession = {
      tetheringId: tetheringId,
      lastTick: currentTick,
    };

    daycareSessions.set(pokemonUuid, newSession);

    return newSession;
  }

  return existingSession;
}
// =============================================================
// LIBRARY EXPORTS
// =============================================================

global.Nog.CobblemonDaycare.GetPokemonName = GetPokemonName;
global.Nog.CobblemonDaycare.NotifyOwner = NotifyOwner;
global.Nog.CobblemonDaycare.GetSafePokemonUuid = GetSafePokemonUuid;
global.Nog.CobblemonDaycare.IsPokemonReadyToEvolve = IsPokemonReadyToEvolve;

global.Nog.CobblemonDaycare.CheckEvolutionNotification =
  CheckEvolutionNotification;
global.Nog.CobblemonDaycare.GetPokemonTetheringId = GetPokemonTetheringId;
global.Nog.CobblemonDaycare.IsPokemonTethered = IsPokemonTethered;
global.Nog.CobblemonDaycare.UpdateDaycareSession = UpdateDaycareSession;
