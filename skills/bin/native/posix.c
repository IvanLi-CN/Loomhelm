#define _GNU_SOURCE
#include <node_api.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <dirent.h>
#include <errno.h>
#include <math.h>
#include <stdio.h>
#include <string.h>
#ifdef __APPLE__
#include <sys/clonefile.h>
#else
#include <sys/syscall.h>
#endif

/* Deliberately exposes only the original toolkit's POSIX operations, not FFI. */
static int integer(napi_env env, napi_value value, int *result) {
  napi_valuetype type;
  double number;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_number ||
      napi_get_value_double(env, value, &number) != napi_ok || !isfinite(number) || number < -2147483648.0 || number > 2147483647.0 || number != (int)number) {
    napi_throw_type_error(env, NULL, "POSIX integer argument required"); return 0;
  }
  *result = (int)number; return 1;
}
static const char *path_arg(napi_env env, napi_value value) {
  bool typed = false;
  napi_typedarray_type type;
  size_t length, offset;
  void *data;
  napi_value buffer;
  napi_is_typedarray(env, value, &typed);
  if (!typed || napi_get_typedarray_info(env, value, &type, &length, &data, &buffer, &offset) != napi_ok ||
      (type != napi_uint8_array && type != napi_uint8_clamped_array) || length == 0 || ((unsigned char *)data)[length-1] != 0 || memchr(data, 0, length-1)) {
    napi_throw_type_error(env, NULL, "NUL-terminated Uint8Array required"); return NULL;
  }
  return data;
}
static napi_value invoke(napi_env env, napi_callback_info info) {
  size_t argc = 2, copied;
  napi_value argv[2], values[5], output;
  char name[40]; uint32_t count;
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc != 2 || napi_get_value_string_utf8(env, argv[0], name, sizeof(name), &copied) != napi_ok ||
      copied >= sizeof(name)-1 || napi_get_array_length(env, argv[1], &count) != napi_ok || count > 5) {
    napi_throw_type_error(env, NULL, "Invalid POSIX call"); return NULL;
  }
  for (uint32_t i=0;i<count;i++) napi_get_element(env, argv[1], i, &values[i]);
  int a=0,b=0,c=0,result=-1; const char *p=NULL,*q=NULL;
  #define I(i,v) if (!integer(env,values[i],&v)) return NULL
  #define P(i,v) if (!(v=path_arg(env,values[i]))) return NULL
  #define ARITY(n) if (count != n) { napi_throw_type_error(env,NULL,"Invalid POSIX arity"); return NULL; }
  if (!strcmp(name,"openat")) { ARITY(4); I(0,a); P(1,p); I(2,b); I(3,c); result=openat(a,p,b,(mode_t)c); }
  else if (!strcmp(name,"flock")) { ARITY(2); I(0,a); I(1,b); result=flock(a,b); }
  else if (!strcmp(name,"close")) { ARITY(1); I(0,a); result=close(a); }
  else if (!strcmp(name,"fchmod")) { ARITY(2); I(0,a); I(1,b); result=fchmod(a,(mode_t)b); }
  else if (!strcmp(name,"mkdirat")) { ARITY(3); I(0,a); P(1,p); I(2,b); result=mkdirat(a,p,(mode_t)b); }
  else if (!strcmp(name,"unlinkat")) { ARITY(3); I(0,a); P(1,p); I(2,b); result=unlinkat(a,p,b); }
  else if (!strcmp(name,"renameat")) { ARITY(4); I(0,a); P(1,p); I(2,b); P(3,q); result=renameat(a,p,b,q); }
  else if (!strcmp(name,"renameat2") || !strcmp(name,"renameatx_np")) {
    ARITY(5); I(0,a); P(1,p); I(2,b); P(3,q); I(4,c);
    #ifdef __APPLE__
    if (strcmp(name,"renameatx_np")) { napi_throw_error(env,NULL,"POSIX symbol unavailable"); return NULL; }
    result=renameatx_np(a,p,b,q,(unsigned int)c);
    #else
    if (strcmp(name,"renameat2")) { napi_throw_error(env,NULL,"POSIX symbol unavailable"); return NULL; }
    result=(int)syscall(SYS_renameat2,a,p,b,q,(unsigned int)c);
    #endif
  }
  #ifdef __APPLE__
  else if (!strcmp(name,"clonefile")) { ARITY(3); P(0,p); P(1,q); I(2,a); result=clonefile(p,q,a); }
  #endif
  else { napi_throw_error(env,NULL,"POSIX symbol unavailable"); return NULL; }
  napi_create_int32(env,result,&output); return output;
}
static napi_value names(napi_env env, napi_callback_info info) {
  size_t argc=1; napi_value argv[1], output, value; int fd;
  napi_get_cb_info(env,info,&argc,argv,NULL,NULL);
  if(argc!=1 || !integer(env,argv[0],&fd)) return NULL;
  int duplicate=dup(fd);
  if(duplicate<0) { napi_throw_error(env,NULL,"Directory duplication failed"); return NULL; }
  DIR *directory=fdopendir(duplicate);
  if(!directory) { close(duplicate); napi_throw_error(env,NULL,"Directory open failed"); return NULL; }
  napi_create_array(env,&output); uint32_t i=0; struct dirent *entry;
  errno=0;
  while((entry=readdir(directory))) {
    napi_create_string_utf8(env,entry->d_name,NAPI_AUTO_LENGTH,&value);
    napi_set_element(env,output,i++,value); errno=0;
  }
  int failure=errno; closedir(directory);
  if(failure) { napi_throw_error(env,NULL,"Directory read failed"); return NULL; }
  return output;
}
static napi_value init(napi_env env,napi_value exports) {
  napi_value fn;
  napi_create_function(env,"invoke",NAPI_AUTO_LENGTH,invoke,NULL,&fn); napi_set_named_property(env,exports,"invoke",fn);
  napi_create_function(env,"directoryNames",NAPI_AUTO_LENGTH,names,NULL,&fn); napi_set_named_property(env,exports,"directoryNames",fn);
  return exports;
}
NAPI_MODULE(loomhelm_posix,init)
