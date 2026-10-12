import { BaseHandler } from "classes/bases";
import { Socket } from "socket.io";
import { HandlerType } from "types";

/**
 * One instance per connected socket (constructed in `MainApp.initSocket`).
 * Register the socket's event listeners in `handle()`.
 */
export class SocketHandler extends BaseHandler {
  override type: HandlerType = "socket.io";

  constructor(private socket: Socket) {
    super();

    this.handleDisconnect = this.handleDisconnect.bind(this);
  }

  override handle(): void {
    console.log(this.socket.id);
    this.socket.on("disconnect", this.handleDisconnect);
  }

  private handleDisconnect(reason: string) {
    console.log(reason, "disconnect reason");
  }
}
