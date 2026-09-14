# Called from Rust through JNI, so R8 must keep the names.
-keep class app.uwumail.UwuBridge { *; }
-keep class app.uwumail.UwuNative { *; }

# rustls-platform-verifier checks certificates through these classes, also via JNI.
-keep, includedescriptorclasses class org.rustls.platformverifier.** { *; }
