# Taproot Solo (Android)

The solo game (`/game/world3d/?solo=1`) packed into an Android app with Capacitor: every file is inside the app, so it runs with no internet and its saves live in the app.

Build a new APK after game changes (needs Android Studio installed):

    cd apps/solo-android && npm install
    JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" npm run apk

The APK lands in `android/app/build/outputs/apk/debug/app-debug.apk`. Installing it over the old one keeps your save.
