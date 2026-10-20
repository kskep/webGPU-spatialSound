import type { Bands } from './model.ts';

// ISO 9613-1 air absorption in dB/m, for octave bands from 63 Hz to 8 kHz.
export function atmosphericLoss(temperatureC = 20, humidityPercent = 50, pressureKPa = 101.325): Bands {
  if (
    !Number.isFinite(temperatureC) ||
    temperatureC < -20 ||
    temperatureC > 50 ||
    !Number.isFinite(humidityPercent) ||
    humidityPercent < 0 ||
    humidityPercent > 100 ||
    !Number.isFinite(pressureKPa) ||
    pressureKPa <= 0
  ) {
    throw new Error('Invalid atmospheric conditions.');
  }

  const kelvin = temperatureC + 273.15;
  const temperatureRatio = kelvin / 293.15;
  const pressureRatio = pressureKPa / 101.325;

  // saturation vapour pressure
  // EDW VRISKOUME TO POSO YDRATMOU STON AERA GIA NA YPOLOGISOUME TIS APWLEIES LOGW YGRASIAS.
  const saturationPressureKPa = 101.325 * Math.pow(10, -6.8346 * Math.pow(273.16 / kelvin, 1.261) + 4.6151);
  const waterConcentration = (humidityPercent * saturationPressureKPa) / pressureKPa;

  // relaxation frequencies
  const oxygenRelaxation =
    pressureRatio *
    (24 + (40400 * waterConcentration * (0.02 + waterConcentration)) / (0.391 + waterConcentration));
  const nitrogenRelaxation =
    pressureRatio *
    Math.pow(temperatureRatio, -0.5) *
    (9 + 280 * waterConcentration * Math.exp(-4.17 * (Math.pow(temperatureRatio, -1 / 3) - 1)));

  const frequencies = [63, 125, 250, 500, 1000, 2000, 4000, 8000];
  return frequencies.map((frequency) => {
    // EDW XWRIZOUME TIS APWLEIES SE KLASIKES, OXYGONOU KAI AZWTOU GIA NA VGALEI dB/m ANA SYXNOTITA.
    const classicalLoss = (1.84e-11 / pressureRatio) * Math.sqrt(temperatureRatio);
    const oxygenLoss =
      (0.01275 * Math.exp(-2239.1 / kelvin)) /
      (oxygenRelaxation + (frequency * frequency) / oxygenRelaxation);
    const nitrogenLoss =
      (0.1068 * Math.exp(-3352 / kelvin)) /
      (nitrogenRelaxation + (frequency * frequency) / nitrogenRelaxation);
    return 8.686 * frequency * frequency *
      (classicalLoss + Math.pow(temperatureRatio, -2.5) * (oxygenLoss + nitrogenLoss));
  }) as Bands;
}
