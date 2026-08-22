// =============================================================
// GNL - GENERIC HELPERS LIBRARY
// =============================================================

// Root namespace
global.Nog = global.Nog || {};

// Generic helpers namespace
global.Nog.Helpers = global.Nog.Helpers || {};

// =============================================================
// FUNCTIONS
// =============================================================

function Debug(DEBUG_param, TAG, message) {
  if (!DEBUG_param) {
    return;
  }

  console.info("[" + TAG + "] " + message);
}

function LogError(tag, context, error) {
  console.error("============================================================");

  console.error("[" + tag + "] ERROR");

  console.error("[" + tag + "] Context: " + context);

  console.error("[" + tag + "] Error: " + String(error));

  try {
    if (error != null && error.stack != null) {
      console.error("[" + tag + "] Stack:\n" + String(error.stack));
    }
  } catch (_) {}

  try {
    if (error != null && error.javaException != null) {
      console.error(
        "[" + tag + "] Java exception: " + String(error.javaException),
      );
    }
  } catch (_) {}

  console.error("============================================================");
}
/*
    usage sample:

    Helpers.LogError(
    LOG_TAG,
    'main daycare scan',
    error
)
    */

// =============================================================
// LIBRARY EXPORTS
// =============================================================

global.Nog.Helpers.Debug = Debug;
global.Nog.Helpers.LogError = LogError;
