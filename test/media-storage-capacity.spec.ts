import {
  evaluateMediaStorageCapacity,
  MediaStorageCapacityPolicyError,
} from "../src/media/media-storage-capacity.js";

describe("evaluateMediaStorageCapacity", () => {
  it("allows a write when both reserves remain satisfied after the file is stored", () => {
    expect(
      evaluateMediaStorageCapacity({
        totalBytes: 1_000,
        freeBytes: 600,
        requiredBytes: 100,
        minimumFreeBytes: 200,
        minimumFreePercent: 20,
      }),
    ).toEqual({
      allowed: true,
      projectedFreeBytes: 500,
      projectedFreePercent: 50,
      byteReserveSatisfied: true,
      percentReserveSatisfied: true,
    });
  });

  it("rejects a write that would cross the byte reserve even when current capacity is healthy", () => {
    expect(
      evaluateMediaStorageCapacity({
        totalBytes: 1_000,
        freeBytes: 300,
        requiredBytes: 150,
        minimumFreeBytes: 200,
        minimumFreePercent: 0,
      }),
    ).toEqual(
      expect.objectContaining({
        allowed: false,
        projectedFreeBytes: 150,
        byteReserveSatisfied: false,
        percentReserveSatisfied: true,
      }),
    );
  });

  it("rejects a write that would cross the percentage reserve", () => {
    expect(
      evaluateMediaStorageCapacity({
        totalBytes: 10_000,
        freeBytes: 2_000,
        requiredBytes: 1_100,
        minimumFreeBytes: 0,
        minimumFreePercent: 10,
      }),
    ).toEqual(
      expect.objectContaining({
        allowed: false,
        projectedFreeBytes: 900,
        projectedFreePercent: 9,
        byteReserveSatisfied: true,
        percentReserveSatisfied: false,
      }),
    );
  });

  it("rejects a file larger than currently available space even when reserves are disabled", () => {
    expect(
      evaluateMediaStorageCapacity({
        totalBytes: 1_000,
        freeBytes: 100,
        requiredBytes: 101,
        minimumFreeBytes: 0,
        minimumFreePercent: 0,
      }),
    ).toEqual(
      expect.objectContaining({
        allowed: false,
        projectedFreeBytes: 0,
        byteReserveSatisfied: true,
        percentReserveSatisfied: true,
      }),
    );
  });

  it("uses current free capacity when no prospective write size is supplied", () => {
    expect(
      evaluateMediaStorageCapacity({
        totalBytes: 1_000,
        freeBytes: 250,
        minimumFreeBytes: 200,
        minimumFreePercent: 20,
      }),
    ).toEqual({
      allowed: true,
      projectedFreeBytes: 250,
      projectedFreePercent: 25,
      byteReserveSatisfied: true,
      percentReserveSatisfied: true,
    });
  });

  it("fails closed on invalid capacity inputs", () => {
    expect(() =>
      evaluateMediaStorageCapacity({
        totalBytes: 100,
        freeBytes: 101,
        minimumFreeBytes: 0,
        minimumFreePercent: 0,
      }),
    ).toThrow(MediaStorageCapacityPolicyError);

    expect(() =>
      evaluateMediaStorageCapacity({
        totalBytes: 100,
        freeBytes: 50,
        minimumFreeBytes: 0,
        minimumFreePercent: 101,
      }),
    ).toThrow("minimumFreePercent must be between 0 and 100");
  });
});
