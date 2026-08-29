// Shared helpers that do not depend on Cobblemon.
global.Nog = global.Nog || {};
global.Nog.Helpers = global.Nog.Helpers || {};

(function (Helpers) {
  const $Component = Java.loadClass("net.minecraft.network.chat.Component");

  function Tell(player, message) {
    player.sendSystemMessage($Component.literal(String(message)));
  }

  function LogError(tag, context, error) {
    console.error("[" + tag + "] " + context + ": " + String(error));
    try {
      if (error != null && error.stack != null) console.error(String(error.stack));
    } catch (_) {}
  }

  function SecondsToTicks(seconds) {
    return Math.floor(Number(seconds) * 20);
  }

  function PersistentKey(prefix, name) {
    return String(prefix) + String(name);
  }

  function GetPersistentValue(server, definitions, prefix, name) {
    let definition = definitions[name];
    if (definition == null) return null;
    let data = server.persistentData;
    let key = PersistentKey(prefix, name);

    if (!data.contains(key) && definition.legacyName != null) {
      let legacyKey = PersistentKey(prefix, definition.legacyName);
      if (data.contains(legacyKey)) data.putInt(key, data.getInt(legacyKey));
    }
    if (!data.contains(key)) {
      if (definition.type === "boolean") data.putBoolean(key, definition.defaultValue);
      else data.putInt(key, definition.defaultValue);
    }
    if (definition.type === "boolean") return data.getBoolean(key);

    let value = Number(data.getInt(key));
    if (!isFinite(value) || value < definition.minimum) {
      value = definition.defaultValue;
      data.putInt(key, value);
    }
    return Math.floor(value);
  }

  function SetPersistentValue(server, definitions, prefix, name, value) {
    let definition = definitions[name];
    if (definition == null) return false;
    let key = PersistentKey(prefix, name);
    if (definition.type === "boolean") {
      server.persistentData.putBoolean(key, Boolean(value));
      return true;
    }
    let integerValue = Math.floor(Number(value));
    if (!isFinite(integerValue) || integerValue < definition.minimum) return false;
    server.persistentData.putInt(key, integerValue);
    return true;
  }

  Helpers.LogError = LogError;
  Helpers.Tell = Tell;
  Helpers.SecondsToTicks = SecondsToTicks;
  Helpers.GetPersistentValue = GetPersistentValue;
  Helpers.SetPersistentValue = SetPersistentValue;
})(global.Nog.Helpers);
