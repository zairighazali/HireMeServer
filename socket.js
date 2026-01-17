// socket.js
import { Server } from "socket.io";

let io;
const connectedUsers = {}; // { firebaseUid: socket.id }

export function initSocket(server, admin) {
  io = new Server(server, { cors: { origin: "*" } });

  // Auth middleware
  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error("Unauthorized"));

    try {
      const decoded = await admin.auth().verifyIdToken(token);
      socket.uid = decoded.uid;
      next();
    } catch {
      next(new Error("Invalid token"));
    }
  });

  io.on("connection", (socket) => {
    console.log("User connected:", socket.uid);
    connectedUsers[socket.uid] = socket.id;

    // Listen for sending messages
    socket.on("send_message", (data) => {
      const { receiverUid } = data;
      const receiverSocket = connectedUsers[receiverUid];
      if (receiverSocket && io) {
        io.to(receiverSocket).emit("receive_message", data);
      }
    });

    socket.on("disconnect", () => {
      console.log("User disconnected:", socket.uid);
      delete connectedUsers[socket.uid];
    });
  });

  return io;
}

// Emit message manually
export function sendMessageToUser(receiverUid, message) {
  const socketId = connectedUsers[receiverUid];
  if (socketId && io) io.to(socketId).emit("receive_message", message);
}

export function getSocket() {
  return { io, connectedUsers };
}
