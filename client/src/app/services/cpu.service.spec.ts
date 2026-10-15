import { fakeAsync, tick } from '@angular/core/testing';
import { CpuService } from './cpu.service';

describe('CPU transport', () => {
  let service: CpuService;
  let socket: any;
  beforeEach(() => {
    socket = { readyState: WebSocket.OPEN, send: jasmine.createSpy('send'), close: jasmine.createSpy('close') };
    spyOn(window, 'WebSocket').and.returnValue(socket);
    Object.assign(window.WebSocket, { OPEN: 1 });
    service = new CpuService();
  });
  afterEach(() => service.cancel(true));

  it('sends config and semantic history and reuses its connection', fakeAsync(() => {
    let commands: any[] = [];
    service.think({ units: {} }, [], 1, 'white', 'normal', 2).then(value => commands = value);
    const request = JSON.parse(socket.send.calls.mostRecent().args[0]);
    expect(request.config).toEqual({ units: {} });
    expect(request.difficulty).toBe('normal');
    socket.onmessage({ data: JSON.stringify({ type: 'cpu_turn', id: request.id, ply: 1, commands: [{ type: 'pass_turn' }] }) });
    tick();
    expect(commands).toEqual([{ type: 'pass_turn' }]);
    service.think({}, [], 2, 'black', 'hard', 5).catch(() => {});
    expect(window.WebSocket).toHaveBeenCalledTimes(1);
  }));

  it('ignores a cancelled request’s late response', fakeAsync(() => {
    let first = false, second = false;
    service.think({}, [], 1, 'white', 'easy', 1).then(() => first = true).catch(() => {});
    service.think({}, [], 2, 'black', 'normal', 2).then(() => second = true).catch(() => {});
    socket.onmessage({ data: JSON.stringify({ type: 'cpu_turn', id: 1, ply: 1, commands: [] }) });
    tick();
    expect(first).toBeFalse(); expect(second).toBeFalse();
    socket.onmessage({ data: JSON.stringify({ type: 'cpu_turn', id: 2, ply: 2, commands: [] }) });
    tick(); expect(second).toBeTrue();
  }));

  it('reports failures and bounds how long it can wait', fakeAsync(() => {
    let message = '';
    service.think({}, [], 1, 'white', 'normal', 2).catch(error => message = error.message);
    tick(20000);
    expect(message).toContain('retry'); expect(socket.close).toHaveBeenCalled();
  }));
  it('rejects malformed semantic commands before releasing the pending request', fakeAsync(() => {
    let message = '';
    service.think({}, [], 1, 'white', 'normal', 2).catch(error => message = error.message);
    socket.onmessage({ data: JSON.stringify({ type: 'cpu_turn', ply: 1, commands: [{ type: 'make_move', from: [], to: '1,0' }] }) });
    tick(); expect(message).toContain('Invalid CPU response'); expect(socket.close).toHaveBeenCalled();
  }));

});
