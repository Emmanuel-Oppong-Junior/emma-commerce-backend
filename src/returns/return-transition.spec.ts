import { Prisma, ReturnStatus } from '../generated/prisma/client';
import { transitionReturn } from './return-transition';

describe('transitionReturn', () => {
  const tx = {
    $queryRaw: jest.fn(),
    returnRequest: { updateMany: jest.fn() },
    returnStatusEvent: { create: jest.fn() },
  };
  const client = tx as unknown as Prisma.TransactionClient;

  beforeEach(() => {
    jest.clearAllMocks();
    tx.$queryRaw.mockResolvedValue([{ status: ReturnStatus.APPROVED }]);
    tx.returnRequest.updateMany.mockResolvedValue({ count: 1 });
  });

  it('moves the locked request only while it still has the status it was read in, and writes the event', async () => {
    const left = await transitionReturn(client, 'rr1', ReturnStatus.RECEIVED, [ReturnStatus.APPROVED], {
      actorId: 'staff1',
      note: 'box dented',
      data: { staffNote: 'box dented' },
    });

    expect(left).toBe(ReturnStatus.APPROVED);
    expect(tx.returnRequest.updateMany).toHaveBeenCalledWith({
      where: { id: 'rr1', status: ReturnStatus.APPROVED },
      data: { staffNote: 'box dented', status: ReturnStatus.RECEIVED },
    });
    expect(tx.returnStatusEvent.create).toHaveBeenCalledWith({
      data: { returnRequestId: 'rr1', from: 'APPROVED', to: 'RECEIVED', actorId: 'staff1', note: 'box dented' },
    });
  });

  it('writes nothing and returns null when the request is missing or in another status', async () => {
    tx.$queryRaw.mockResolvedValueOnce([]);
    expect(await transitionReturn(client, 'rr1', ReturnStatus.RECEIVED, [ReturnStatus.APPROVED])).toBeNull();

    tx.$queryRaw.mockResolvedValueOnce([{ status: ReturnStatus.CANCELLED }]);
    expect(await transitionReturn(client, 'rr1', ReturnStatus.RECEIVED, [ReturnStatus.APPROVED])).toBeNull();

    expect(tx.returnRequest.updateMany).not.toHaveBeenCalled();
    expect(tx.returnStatusEvent.create).not.toHaveBeenCalled();
  });

  it('writes no event when the conditional update loses', async () => {
    tx.returnRequest.updateMany.mockResolvedValueOnce({ count: 0 });

    expect(await transitionReturn(client, 'rr1', ReturnStatus.RECEIVED, [ReturnStatus.APPROVED])).toBeNull();
    expect(tx.returnStatusEvent.create).not.toHaveBeenCalled();
  });

  it('throws for a move the table does not allow, before touching the database', async () => {
    await expect(transitionReturn(client, 'rr1', ReturnStatus.REFUNDED, [ReturnStatus.APPROVED])).rejects.toThrow(
      /no APPROVED -> REFUNDED transition/,
    );
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });

  it('rethrows database errors', async () => {
    tx.returnRequest.updateMany.mockRejectedValueOnce(new Error('connection lost'));

    await expect(transitionReturn(client, 'rr1', ReturnStatus.RECEIVED, [ReturnStatus.APPROVED])).rejects.toThrow(
      'connection lost',
    );
  });
});
