// Create the root namespace when it does not exist yet.
global.Nog = global.Nog || {};

// Create the namespace that stores our small tested functions.
global.Nog.TestedFunctions = global.Nog.TestedFunctions || {};

// Load Minecraft's text-component class so we can create chat messages.
const $Component = Java.loadClass("net.minecraft.network.chat.Component");

// Define a function that sends one message to every online player.
function SendMessageToAllPlayers(server, message) {
  // Get an iterator containing all players currently connected to the server.
  let players = server.getPlayerList().getPlayers().iterator();

  // Continue until the iterator has no players left.
  while (players.hasNext()) {
    // Get the next online player from the iterator.
    let player = players.next();

    // Convert the provided text into a Minecraft component and send it in chat.
    player.sendSystemMessage($Component.literal(String(message)));
  }
}

// Export the function so server scripts can use it.
global.Nog.TestedFunctions.SendMessageToAllPlayers = SendMessageToAllPlayers;
