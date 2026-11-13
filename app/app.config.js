// Настройки приложения лежат в app.json, этот файл их только дополняет.
// Тестовый APK (workflow «Тестовый APK», .github/workflows/android-test.yml) собирается с
// VACANTE_TEST_BUILD=<номер сборки>: своё имя пакета, чтобы стоять рядом с будущей версией из
// Google Play, название «Vacante тест» и номер сборки, чтобы новая ставилась поверх прежней.
// Сборка для Google Play (workflow «Google Play», .github/workflows/android.yml) задаёт
// VACANTE_VERSION_CODE=<номер прогона>: Google Play принимает только номер больше прежнего.
module.exports = ({ config }) => {
  const code = Number(process.env.VACANTE_VERSION_CODE);
  if (Number.isSafeInteger(code) && code > 0) {
    config = { ...config, android: { ...config.android, versionCode: code } };
  }
  const build = Number(process.env.VACANTE_TEST_BUILD);
  if (!Number.isSafeInteger(build) || build <= 0) return config;
  return {
    ...config,
    name: 'Vacante тест',
    version: `${config.version}-test.${build}`,
    android: { ...config.android, package: `${config.android.package}.test`, versionCode: build },
  };
};
