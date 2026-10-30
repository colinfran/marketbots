import { describe, expect, it } from "vitest"
import { cpuModel } from "../src/collector"
import { cpuSensors, diskRates, libreSensors, motherboardFans, sensorValue } from "../src/lhm"
import { parseNvidia } from "../src/nvidia"
import { finiteReading } from "../src/vesync"

const sensor = (SensorId: string, Text: string, Type: string, RawValue: string) => ({ SensorId, Text, Type, RawValue })

/** A trimmed copy of the server's own LHM tree (an i5-11400 on an NCT6798D board). */
const TREE = {
  Children: [
    {
      HardwareId: "/lpc/nct6798d/0",
      Children: [
        sensor("/lpc/nct6798d/0/fan/0", "Fan #1", "Fan", "1513 RPM"),
        sensor("/lpc/nct6798d/0/fan/2", "Fan #3", "Fan", "0 RPM"),
        sensor("/lpc/nct6798d/0/fan/4", "Fan #5", "Fan", "1247 RPM"),
        sensor("/lpc/nct6798d/0/control/0", "Fan #1", "Control", "100.0 %"),
        sensor("/lpc/nct6798d/0/control/2", "Fan #3", "Control", "60.0 %"),
        sensor("/lpc/nct6798d/0/control/4", "Fan #5", "Control", "100.0 %"),
      ],
    },
    {
      HardwareId: "/intelcpu/0",
      Children: [
        sensor("/intelcpu/0/power/0", "CPU Package", "Power", "56.9 W"),
        sensor("/intelcpu/0/clock/0", "Bus Speed", "Clock", "99.7 MHz"),
        sensor("/intelcpu/0/clock/1", "CPU Core #1", "Clock", "3600 MHz"),
        sensor("/intelcpu/0/clock/2", "CPU Core #2", "Clock", "4200 MHz"),
        sensor("/intelcpu/0/temperature/0", "Core Max", "Temperature", "38.0 °C"),
        sensor("/intelcpu/0/temperature/8", "CPU Package", "Temperature", "38.0 °C"),
      ],
    },
    {
      HardwareId: "/nvme/0",
      Children: [sensor("/nvme/0/throughput/54", "Read Rate", "Throughput", "1024.0 B/s"), sensor("/nvme/0/throughput/55", "Write Rate", "Throughput", "430099.5 B/s")],
    },
    { HardwareId: "/gpu-nvidia/0", Children: [sensor("/gpu-nvidia/0/throughput/0", "GPU PCIe Rx", "Throughput", "1.8 MB/s")] },
  ],
}

describe("sensorValue", () => {
  it("reads LHM's value strings in base units", () => {
    expect(sensorValue("45.5 °C")).toBe(45.5)
    expect(sensorValue("212 °F")).toBe(100)
    expect(sensorValue("1513 RPM")).toBe(1513)
    expect(sensorValue("40,5 %")).toBe(40.5)
    expect(sensorValue("63.1 W")).toBe(63.1)
    expect(sensorValue("4187.1 MHz")).toBe(4187.1)
    expect(sensorValue("2 KB/s")).toBe(2048)
    expect(sensorValue(12)).toBe(12)
  })

  it("is null for anything else", () => {
    expect(sensorValue("-")).toBeNull()
    expect(sensorValue("12 parsecs")).toBeNull()
    expect(sensorValue(Number.NaN)).toBeNull()
    expect(sensorValue(undefined)).toBeNull()
  })
})

describe("the sensor tree", () => {
  const sensors = libreSensors(TREE)

  it("flattens it with each sensor's hardware", () => {
    expect(sensors.find((s) => s.id === "/intelcpu/0/power/0")).toEqual({ id: "/intelcpu/0/power/0", hardwareId: "/intelcpu/0", name: "CPU Package", type: "Power", value: 56.9 })
    expect(() => libreSensors({})).toThrow(/invalid sensor tree/)
  })

  it("finds the CPU package temperature, its cores' clock and its power", () => {
    expect(cpuSensors(sensors)).toEqual({ temperature_c: 38, clock_mhz: 3900, power_w: 56.9, fan_rpm: null })
  })

  it("rejects an impossible CPU temperature", () => {
    const hot = libreSensors({ Children: [{ HardwareId: "/intelcpu/0", Children: [sensor("/intelcpu/0/temperature/8", "CPU Package", "Temperature", "200 °C")] }] })
    expect(cpuSensors(hot).temperature_c).toBeNull()
  })

  it("adds up the drives' rates, not the cards' PCIe traffic", () => {
    expect(diskRates(sensors)).toEqual({ read_bps: 1024, write_bps: 430099.5 })
    expect(diskRates([])).toEqual({ read_bps: null, write_bps: null })
  })

  it("pairs each motherboard fan header with its fan's RPM", () => {
    expect(motherboardFans(sensors)).toEqual([
      { id: "/lpc/nct6798d/0/control/0", name: "Fan #1", pct: 100, rpm: 1513 },
      { id: "/lpc/nct6798d/0/control/2", name: "Fan #3", pct: 60, rpm: 0 },
      { id: "/lpc/nct6798d/0/control/4", name: "Fan #5", pct: 100, rpm: 1247 },
    ])
  })
})

describe("parseNvidia", () => {
  it("reads every card, with units in bytes and unsupported fields null", () => {
    const gpus = parseNvidia(
      [
        "0, GPU-0a8e, NVIDIA GeForce RTX 3070, 617.42, 11, 4, 6896, 8192, 42, 14.78, 220.00, 30",
        "1, GPU-c2f6, NVIDIA GeForce RTX 2080 SUPER, 617.42, 0, 0, 6787, 8192, 42, 20.35, 180.00, [N/A]",
        "",
      ].join("\r\n"),
    )
    expect(gpus).toHaveLength(2)
    expect(gpus[0]).toEqual({
      id: "GPU-0a8e",
      index: 0,
      model: "NVIDIA GeForce RTX 3070",
      driver: "617.42",
      utilization: 11,
      memory_utilization: 4,
      memory_used_bytes: 6896 * 1024 ** 2,
      memory_total_bytes: 8192 * 1024 ** 2,
      temperature_c: 42,
      power_w: 14.78,
      power_limit_w: 220,
      fan_pct: 30,
    })
    expect(gpus[1].fan_pct).toBeNull()
    expect(gpus[1].power_limit_w).toBe(180)
  })
})

describe("small readers", () => {
  it("cleans up the CPU's model name", () => {
    expect(cpuModel("11th Gen Intel(R) Core(TM) i5-11400 @ 2.60GHz")).toBe("11th Gen Intel Core i5-11400")
    expect(cpuModel(undefined)).toBeNull()
  })

  it("keeps only non-negative outlet readings", () => {
    expect(finiteReading("42.5")).toBe(42.5)
    expect(finiteReading(0)).toBe(0)
    expect(finiteReading(-1)).toBeNull()
    expect(finiteReading("Not supported")).toBeNull()
    expect(finiteReading({})).toBeNull()
  })
})
