import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';

// Real-time notifications over WebSocket (socket.io).
@WebSocketGateway({
  cors: { origin: 'http://localhost:5173', credentials: true },
})
export class NotificationsGateway implements OnGatewayConnection {
  @WebSocketServer()
  server: Server;

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  // Authenticate the handshake with the access token, then put the socket in a
  // per-user room so we can target individual users.
  handleConnection(client: Socket) {
    try {
      const raw =
        (client.handshake.auth?.token as string | undefined) ??
        client.handshake.headers.authorization?.replace('Bearer ', '');

      if (!raw) throw new Error('No token');

      const payload = this.jwt.verify<{ sub: string }>(raw, {
        secret: this.config.getOrThrow<string>('JWT_SECRET'),
      });

      void client.join(this.room(payload.sub));
    } catch {
      client.disconnect();
    }
  }

  // Push a payload to every open socket belonging to a user.
  emitToUser(userId: string, event: string, data: unknown) {
    this.server.to(this.room(userId)).emit(event, data);
  }

  private room(userId: string) {
    return `user:${userId}`;
  }
}
