# Called from Rust through JNI, so R8 must keep the names.
-keep class app.uwumail.UwuBridge { *; }
-keep class app.uwumail.UwuNative { *; }
